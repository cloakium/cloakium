/**
 * Hardening: credentials never reach a diagnostic, the executable/proxy/args
 * contract cannot be overridden through `launchOptions`, and egress discovery
 * refuses a private echo answer. No Chromium required.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

import {
  buildLaunchOptions,
  GeoipLookupError,
  GeoipUnavailableError,
  maybeResolveGeoip,
  parseProxy,
  ProxyAuthUnsupportedError,
  resolveEgressIp,
} from "../../dist/index.js";
import { test } from "./harness.mjs";

const SECRETS = ["alice", "hunter2"];

async function withEnv(patch, fn) {
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

function withoutSecrets(error) {
  for (const secret of SECRETS) {
    assert.equal(
      error.message.includes(secret),
      false,
      `diagnostic leaked "${secret}": ${error.message}`,
    );
  }
  return true;
}

async function failure(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to throw");
}

async function echoServer(body) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${body}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("credentialed proxy URLs are split into fields", () => {
  const parsed = parseProxy({ server: "http://alice:hunter2@proxy.example:8080" });
  assert.equal(parsed.server, "http://proxy.example:8080");
  assert.equal(parsed.username, "alice");
  assert.equal(parsed.password, "hunter2");
  assert.equal(parsed.server.includes("@"), false);
});

test("rejected SOCKS credentials are never echoed", async () => {
  for (const proxy of [
    "socks5://alice:hunter2@proxy.example:1080",
    { server: "socks5://alice:hunter2@proxy.example:1080" },
    { server: "socks4://proxy.example:1080", username: "alice", password: "hunter2" },
  ]) {
    const error = await failure(() => parseProxy(proxy));
    assert.ok(error instanceof ProxyAuthUnsupportedError);
    withoutSecrets(error);
  }
});

test("unparsable proxy input is redacted", async () => {
  const error = await failure(() => parseProxy("http://alice:hunter2@"));
  assert.ok(error instanceof ProxyAuthUnsupportedError);
  withoutSecrets(error);
  assert.match(error.message, /http:\/\/\*\*\*@/);
});

test("GeoIP proxy failures do not leak credentials", async () => {
  await withEnv(
    {
      CLOAKIUM_GEOIP_DB: undefined,
      CLOAKBROWSER_GEOIP_DB: undefined,
      CLOAKIUM_GEOIP_IP: undefined,
      CLOAKIUM_GEOIP_TIMEOUT_MS: "2000",
    },
    async () => {
      // Without a database the lookup fails before any network access, but the
      // diagnostic must still be credential-free.
      const socks = await failure(() =>
        maybeResolveGeoip({ geoip: true, proxy: "socks5://alice:hunter2@127.0.0.1:9" }),
      );
      assert.ok(
        socks instanceof GeoipUnavailableError || socks instanceof ProxyAuthUnsupportedError,
        socks.message,
      );
      withoutSecrets(socks);

      // The proxy tunnel itself: credentials live only in the parsed fields.
      const parsed = parseProxy("http://alice:hunter2@127.0.0.1:9");
      const refused = await failure(() => resolveEgressIp(parsed, 2_000, {}));
      withoutSecrets(refused);
      assert.equal(parsed.server, "http://127.0.0.1:9");
    },
  );
});

test("a resolver's failure is scrubbed too", async () => {
  const error = await failure(() =>
    maybeResolveGeoip({
      geoip: true,
      proxy: "http://alice:hunter2@proxy.example:8080",
      geoipResolver: () => {
        throw new Error("tunnel to http://alice:hunter2@proxy.example:8080 failed");
      },
    }),
  );
  withoutSecrets(error);
  assert.match(error.message, /http:\/\/\*\*\*@proxy\.example:8080/);
});

test("egress discovery accepts an HTTP echo endpoint", async () => {
  const server = await echoServer("203.0.113.9");
  try {
    const ip = await resolveEgressIp(undefined, 3_000, { CLOAKIUM_GEOIP_ECHO_URL: server.url });
    assert.equal(ip, "203.0.113.9");
  } finally {
    await server.close();
  }
});

test("a private echo answer is rejected unless the IP is explicit", async () => {
  const server = await echoServer("127.0.0.1");
  try {
    const error = await failure(() =>
      resolveEgressIp(undefined, 3_000, { CLOAKIUM_GEOIP_ECHO_URL: server.url }),
    );
    assert.ok(error instanceof GeoipLookupError);
    assert.match(error.message, /private or loopback/);

    const explicit = await resolveEgressIp(undefined, 3_000, {
      CLOAKIUM_GEOIP_ECHO_URL: server.url,
      CLOAKIUM_GEOIP_IP: "127.0.0.1",
    });
    assert.equal(explicit, "127.0.0.1");
  } finally {
    await server.close();
  }
});

test("an unsupported echo URL fails with an actionable error", async () => {
  const error = await failure(() =>
    resolveEgressIp(undefined, 500, { CLOAKIUM_GEOIP_ECHO_URL: "ftp://127.0.0.1/" }),
  );
  assert.ok(error instanceof GeoipLookupError);
  assert.match(error.message, /http or https/);
});

test("headless launches never emit --start-maximized", async () => {
  await withEnv({ CLOAKIUM_BINARY_PATH: process.execPath }, async () => {
    const headless = await buildLaunchOptions({ fingerprintSeed: "12345" });
    assert.equal(headless.headless, true);
    assert.equal(headless.args.includes("--start-maximized"), false);

    const headed = await buildLaunchOptions({ headless: false, fingerprintSeed: "12345" });
    assert.equal(headed.args.includes("--start-maximized"), true);
    assert.equal(headed.args.includes("--ignore-gpu-blocklist"), true);

    const sized = await buildLaunchOptions({
      headless: false,
      fingerprintSeed: "12345",
      args: ["--window-size=800,600"],
    });
    assert.equal(sized.args.includes("--start-maximized"), false);
  });
});

test("launchOptions cannot replace the executable, proxy, args or headless flag", async () => {
  await withEnv({ CLOAKIUM_BINARY_PATH: process.execPath }, async () => {
    const options = await buildLaunchOptions({
      proxy: "http://alice:hunter2@proxy.example:8080",
      args: ["--disable-gpu"],
      launchOptions: {
        executablePath: "/definitely/not/chromium",
        args: ["--replaced-args"],
        headless: false,
        proxy: { server: "http://evil.example:1" },
        timeout: 5_000,
      },
    });

    assert.equal(options.executablePath, fs.realpathSync(process.execPath));
    assert.equal(options.headless, true);
    assert.equal(options.timeout, 5_000, "unrelated launch options still forward");
    assert.ok(options.args.includes("--disable-gpu"));
    assert.equal(options.args.includes("--replaced-args"), false);
    assert.ok(options.args.some((arg) => arg.startsWith("--fingerprint=")));

    assert.equal(options.proxy.server, "http://proxy.example:8080");
    assert.equal(options.proxy.username, "alice");
    assert.equal(options.proxy.password, "hunter2");
    assert.equal(options.proxy.server.includes("hunter2"), false);

    // The wrapper's default-arg suppression is authoritative unless the caller
    // asks for a complete replacement.
    assert.deepEqual(options.ignoreDefaultArgs, ["--enable-automation"]);
    const replaced = await buildLaunchOptions({
      launchOptions: { ignoreDefaultArgs: true, executablePath: "/nope" },
    });
    assert.equal(replaced.ignoreDefaultArgs, true);
    assert.equal(replaced.executablePath, fs.realpathSync(process.execPath));
  });
});

test("a proxy passed through launchOptions is normalised too", async () => {
  await withEnv({ CLOAKIUM_BINARY_PATH: process.execPath }, async () => {
    const options = await buildLaunchOptions({
      launchOptions: { proxy: "http://alice:hunter2@proxy.example:8080" },
    });
    assert.equal(options.proxy.server, "http://proxy.example:8080");
    assert.equal(options.proxy.username, "alice");

    const error = await failure(() =>
      buildLaunchOptions({ launchOptions: { proxy: "socks5://alice:hunter2@proxy.example:1080" } }),
    );
    assert.ok(error instanceof ProxyAuthUnsupportedError);
    withoutSecrets(error);
  });
});

test("a failed binary lookup is reported without proxy credentials", async () => {
  const error = await failure(() =>
    withEnv({ CLOAKIUM_BINARY_PATH: "/definitely/missing/chromium", PATH: "" }, () =>
      buildLaunchOptions({ proxy: "http://alice:hunter2@proxy.example:8080" }),
    ),
  );
  assert.equal(error.name, "BinaryNotFoundError");
  withoutSecrets(error);
});
