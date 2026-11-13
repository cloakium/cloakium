/**
 * API-shape and option-assembly checks. No browser required.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  BinaryNotFoundError,
  buildContextOptions,
  buildLaunchOptions,
  getDefaultStealthArgs,
  LEGACY_SEED_FILE,
  ProxyAuthUnsupportedError,
  resolveBinaryPath,
  SEED_FILE,
  tryResolveBinaryPath,
  applyProfileSeed,
  profileSeed,
  parseProxy,
  maybeResolveGeoip,
  GeoipUnavailableError,
  ConfigurationError,
} from "../../dist/index.js";
import { resolveConfig, mergeConfig } from "../../dist/human/index.js";
import { test } from "./harness.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("public entry points exist", () => {
  const expected = [
    "launch",
    "launchContext",
    "launchPersistentContext",
    "buildLaunchOptions",
    "buildContextOptions",
    "humanizeBrowser",
    "resolveBinaryPath",
    "tryResolveBinaryPath",
    "parseProxy",
    "applyProfileSeed",
    "profileSeed",
    "maybeResolveGeoip",
    "resolveEgressIp",
    "isPrivateIp",
  ];
  return import("../../dist/index.js").then((mod) => {
    for (const name of expected) assert.equal(typeof mod[name], "function", name);
    assert.equal(typeof mod.LEGACY_SEED_FILE, "string");
    assert.equal(typeof mod.SEED_FILE, "string");
  });
});

test("context options default to no viewport and pass locale/timezone through", () => {
  const base = buildContextOptions();
  assert.equal(base.viewport, null);

  const explicit = buildContextOptions({ viewport: { width: 800, height: 600 } });
  assert.deepEqual(explicit.viewport, { width: 800, height: 600 });

  const fromContext = buildContextOptions({ contextOptions: { viewport: { width: 640, height: 480 } } });
  assert.deepEqual(fromContext.viewport, { width: 640, height: 480 });

  const geo = buildContextOptions({ locale: "de-DE", timezone: "Europe/Berlin" });
  assert.equal(geo.locale, "de-DE");
  assert.equal(geo.timezoneId, "Europe/Berlin");

  const wrapped = buildContextOptions({
    locale: "fr-FR",
    contextOptions: { locale: "en-US", extraHTTPHeaders: { "x-test": "1" } },
  });
  assert.equal(wrapped.locale, "fr-FR");
  assert.deepEqual(wrapped.extraHTTPHeaders, { "x-test": "1" });
});

test("stealth defaults emit the fingerprint seed and the WebRTC policy", () => {
  const args = getDefaultStealthArgs("4242");
  assert.deepEqual(args, [
    "--fingerprint=4242",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]);
  for (const forbidden of ["--no-sandbox", "--fingerprint-platform", "--lang", "--fingerprint-timezone"]) {
    assert.ok(!args.some((arg) => arg.startsWith(forbidden)), `unexpected ${forbidden}`);
  }
});

test("launch options assemble privacy args and enable the Chromium sandbox", async () => {
  const options = await withEnvAsync({ CLOAKIUM_BINARY_PATH: process.execPath }, () =>
    buildLaunchOptions({
      headless: false,
      fingerprintSeed: "12345",
      args: ["--window-size=800,600"],
    }),
  );

  assert.equal(options.executablePath, fs.realpathSync(process.execPath));
  assert.equal(options.headless, false);
  assert.equal(options.chromiumSandbox, true);
  assert.deepEqual(options.ignoreDefaultArgs, ["--enable-automation"]);

  const args = options.args;
  assert.ok(args.includes("--fingerprint=12345"));
  assert.ok(args.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(args.includes("--window-size=800,600"));
  assert.ok(args.includes("--ignore-gpu-blocklist"));
  assert.ok(!args.includes("--start-maximized"), "window size suppresses maximize");
  assert.ok(!args.some((arg) => arg === "--no-sandbox"));
  assert.ok(!args.some((arg) => arg.startsWith("--lang")));
  assert.ok(!args.some((arg) => arg.startsWith("--fingerprint-platform")));
  assert.equal(options.proxy, undefined);
});

test("sandbox disabling requires an explicit launch option", async () => {
  const options = await withEnvAsync({ CLOAKIUM_BINARY_PATH: process.execPath }, () =>
    buildLaunchOptions({ launchOptions: { chromiumSandbox: false } }),
  );
  assert.equal(options.chromiumSandbox, false);
});

test("caller args override the generated fingerprint", async () => {
  const options = await withEnvAsync({ CLOAKIUM_BINARY_PATH: process.execPath }, () =>
    buildLaunchOptions({ fingerprintSeed: "11111", args: ["--fingerprint=22222"] }),
  );
  assert.ok(options.args.includes("--fingerprint=22222"));
  assert.ok(!options.args.includes("--fingerprint=11111"));
  assert.equal(options.headless, true);
});

test("binary resolution honours the new env, then the legacy env", () => {
  const node = process.execPath;
  assert.equal(tryResolveBinaryPath({ CLOAKIUM_BINARY_PATH: node, PATH: "" }), fs.realpathSync(node));
  assert.equal(tryResolveBinaryPath({ CLOAKBROWSER_BINARY_PATH: node, PATH: "" }), fs.realpathSync(node));
  assert.equal(
    tryResolveBinaryPath({
      CLOAKIUM_BINARY_PATH: node,
      CLOAKBROWSER_BINARY_PATH: "/definitely/missing",
      PATH: "",
    }),
    fs.realpathSync(node),
  );
});

test("binary resolution finds cloakium-chromium on PATH", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-bin-"));
  const binary = path.join(directory, "cloakium-chromium");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(tryResolveBinaryPath({ PATH: directory }), fs.realpathSync(binary));
});

test("binary resolution fails closed", () => {
  assert.equal(tryResolveBinaryPath({ PATH: "/nonexistent" }), undefined);
  assert.throws(() => resolveBinaryPath({ PATH: "/nonexistent" }), BinaryNotFoundError);
  assert.throws(
    () => tryResolveBinaryPath({ CLOAKIUM_BINARY_PATH: "/nonexistent/chrome", PATH: "" }),
    BinaryNotFoundError,
  );
});

test("proxy URLs become Playwright proxy objects", () => {
  assert.deepEqual(parseProxy("http://user:p%40ss@proxy.example:8080"), {
    server: "http://proxy.example:8080",
    username: "user",
    password: "p@ss",
  });
  assert.deepEqual(parseProxy({ server: "proxy.example:3128", bypass: ".internal" }), {
    server: "http://proxy.example:3128",
    bypass: ".internal",
  });
  assert.deepEqual(parseProxy("socks5://proxy.example:1080"), {
    server: "socks5://proxy.example:1080",
  });
  assert.equal(parseProxy(undefined), undefined);
});

test("SOCKS credentials are rejected explicitly", () => {
  assert.throws(() => parseProxy("socks5://user:pass@proxy.example:1080"), ProxyAuthUnsupportedError);
  assert.throws(
    () => parseProxy({ server: "socks5://proxy.example:1080", username: "user" }),
    ProxyAuthUnsupportedError,
  );
});

test("profile seed is deterministic, persisted and reused", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-seed-"));
  const args = applyProfileSeed(directory, undefined, ["--window-size=800,600"]);
  assert.ok(args[0].startsWith("--fingerprint="));
  assert.equal(args[1], "--window-size=800,600");

  const file = path.join(directory, SEED_FILE);
  const stored = fs.readFileSync(file, "utf8").trim();
  assert.match(stored, /^\d{5}$/);
  assert.equal(`--fingerprint=${stored}`, args[0]);
  assert.equal(profileSeed(directory), Number(stored));

  const again = applyProfileSeed(directory, undefined, undefined);
  assert.equal(again[0], args[0]);
});

test("concurrent first launches converge on one seed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-seed-race-"));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve(applyProfileSeed(directory, undefined, undefined))),
  );
  const seeds = new Set(results.map((args) => args[0]));
  assert.equal(seeds.size, 1, `expected one seed, got ${[...seeds].join(", ")}`);
  assert.equal(fs.readFileSync(path.join(directory, SEED_FILE), "utf8").trim(), results[0][0].split("=")[1]);
});

test("legacy profile seed is preserved and no new file is written", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-seed-legacy-"));
  fs.writeFileSync(path.join(directory, LEGACY_SEED_FILE), "54321\n");
  const args = applyProfileSeed(directory, undefined, undefined);
  assert.equal(args[0], "--fingerprint=54321");
  assert.equal(fs.existsSync(path.join(directory, SEED_FILE)), false);
});

test("an explicit fingerprint leaves the profile alone", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-seed-explicit-"));
  const args = applyProfileSeed(directory, undefined, ["--fingerprint=off"]);
  assert.deepEqual(args, ["--fingerprint=off"]);
  assert.equal(fs.existsSync(path.join(directory, SEED_FILE)), false);
  assert.equal(fs.existsSync(path.join(directory, LEGACY_SEED_FILE)), false);

  assert.deepEqual(applyProfileSeed(directory, false, ["--x"]), ["--x"]);
});

test("human config presets validate and merge", () => {
  const base = resolveConfig();
  const careful = resolveConfig("careful");
  assert.ok(careful.keyGap[0] > base.keyGap[0]);
  assert.equal(Object.isFrozen(base), true);

  const merged = mergeConfig(base, { pathPoints: 4, mistakeChance: 0.5 });
  assert.equal(merged.pathPoints, 4);
  assert.equal(merged.mistakeChance, 0.5);
  assert.equal(merged.pathCurve, base.pathCurve);

  assert.throws(() => resolveConfig("nope"), ConfigurationError);
  assert.throws(() => mergeConfig(base, { unknownField: 1 }), ConfigurationError);
  assert.throws(() => mergeConfig(base, { pathPoints: -1 }), ConfigurationError);
  assert.throws(() => mergeConfig(base, { pressPause: [100, 10] }), ConfigurationError);
  assert.throws(() => mergeConfig(base, { wheelNotch: 0 }), ConfigurationError);
});

test("geoip fails closed without a database or resolver", async () => {
  await assert.rejects(
    () => withEnvAsync({ CLOAKIUM_GEOIP_DB: undefined, CLOAKBROWSER_GEOIP_DB: undefined }, () =>
      maybeResolveGeoip({ geoip: true }),
    ),
    (error) => error instanceof GeoipUnavailableError && /CLOAKIUM_GEOIP_DB/.test(error.message),
  );

  const resolved = await maybeResolveGeoip({
    geoip: true,
    geoipResolver: () => ({ timezone: "Europe/Berlin", locale: "de-DE" }),
  });
  assert.deepEqual(resolved, { timezone: "Europe/Berlin", locale: "de-DE" });

  const explicit = await maybeResolveGeoip({
    geoip: true,
    timezone: "Asia/Tokyo",
    locale: "ja-JP",
  });
  assert.deepEqual(explicit, { timezone: "Asia/Tokyo", locale: "ja-JP" });
});

test("geoip reports a missing database file", async () => {
  await assert.rejects(
    () => withEnvAsync({ CLOAKIUM_GEOIP_DB: "/nonexistent/GeoLite2-City.mmdb" }, () =>
      maybeResolveGeoip({ geoip: true }),
    ),
    (error) => error instanceof GeoipUnavailableError && /does not exist/.test(error.message),
  );
});

test("the build cleans stale dist output before compiling", () => {
  const dist = path.join(root, "dist");
  const orphan = path.join(dist, "stale-upstream-module.js");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(orphan, "// stale compiled output\n");
  const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(fs.existsSync(orphan), false, "stale dist file must be removed");
  assert.equal(fs.existsSync(path.join(dist, "index.js")), true);
  assert.equal(fs.existsSync(path.join(dist, "human", "index.js")), true);
});

test("created sources contain no third-party names or Playwright internals", () => {
  // Built at runtime so this assertion cannot match itself.
  const attribution = ["Cloak" + "HQ", "Cloak" + "Browser"];
  const internals = [
    "_create" + "RemoteObject",
    "_element" + "Channel",
    "injected" + "ScriptSource",
    "_cloak" + "Human",
  ];
  const legacy = /CLOAKBROWSER_[A-Z_]+|\.cloakbrowser-seed/g;
  const roots = ["src", "dist", "tests/browser", "tests/human"];
  const offenders = [];
  const scan = (file) => {
    const body = fs.readFileSync(file, "utf8");
    for (const needle of [...attribution, ...internals]) {
      if (body.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
    const withoutLegacy = body.replace(legacy, "");
    if (new RegExp("cloak" + "browser", "i").test(withoutLegacy)) {
      offenders.push(`${file}: legacy name outside an allowed identifier`);
    }
  };
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs|md|json)$/.test(entry.name) && entry.name !== "api.test.mjs") scan(full);
    }
  };
  for (const directory of roots) walk(path.join(root, directory));
  // docs/api.md is this package's own documentation; other files in docs/
  // belong to the repository owner and are not scanned here.
  scan(path.join(root, "docs", "api.md"));
  assert.deepEqual(offenders, []);
});
