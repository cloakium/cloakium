import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const artifacts = resolve(root, "artifacts");
const loadPackage = createRequire(import.meta.url);
mkdirSync(artifacts, { recursive: true });
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, node: process.versions.node,
  system: { "linux:x64": "x86_64-linux", "linux:arm64": "aarch64-linux" }[`${process.platform}:${process.arch}`],
  sourceRevision: process.env.CLOAKIUM_SOURCE_REVISION ?? null,
  execution: { kind: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
    repository: process.env.GITHUB_REPOSITORY ?? null, runId: process.env.GITHUB_RUN_ID ?? null },
  flakeLock: createHash("sha256").update(readFileSync(resolve(root, "flake.lock"))).digest("hex"),
  checks: [], status: "running" };

function save() {
  writeFileSync(resolve(artifacts, "verification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

function check(name, command, args, timeout = 900_000) {
  const log = resolve(artifacts, `${name}.log`);
  const descriptor = openSync(log, "w");
  const started = Date.now();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: root, env: process.env, stdio: ["ignore", descriptor, descriptor],
      timeout, killSignal: "SIGKILL",
    });
  } finally {
    closeSync(descriptor);
  }
  const entry = { name, command: [command, ...args], exitCode: result.status,
    signal: result.signal, durationMs: Date.now() - started, log: `artifacts/${name}.log` };
  if (result.error) entry.error = result.error.message;
  evidence.checks.push(entry);
  save();
  if (result.error || result.status !== 0) {
    throw new Error(`${name} failed; diagnostics: ${log}\n${readFileSync(log, "utf8")}`);
  }
  console.log(`${name}: passed (${entry.durationMs} ms)`);
}

try {
  const binary = process.env.CLOAKIUM_BINARY_PATH;
  assert.ok(binary, "CLOAKIUM_BINARY_PATH must identify the source-built Cloakium browser");
  assert.ok(evidence.system, "Native release verification supports Linux x86-64 and ARM64");
  const upstream = JSON.parse(readFileSync(resolve(root, "upstream.json"), "utf8"));
  const driver = loadPackage("playwright-core/package.json");
  assert.equal(driver.version, upstream.playwright.version, "Driver version differs from the release pin");
  assert.ok(driver.cloakium, "Verification requires the patched driver, not stock playwright-core");
  evidence.binary = binary;
  evidence.binaryRealpath = realpathSync(binary);
  evidence.playwright = driver.version;
  evidence.driverPatches = driver.cloakium;
  check("browser-version", binary, ["--version"], 30_000);
  evidence.browserVersion = readFileSync(resolve(artifacts, "browser-version.log"), "utf8").trim();
  assert.ok(upstream.chromium?.version, "A Chromium version pin is required");
  const version = evidence.browserVersion.match(/\b(\d+\.\d+\.\d+\.\d+)\b/);
  assert.equal(version?.[1], upstream.chromium.version, "Browser version differs from the release pin");
  check("build-library", "npm", ["run", "build"]);
  check("typecheck", "npm", ["run", "typecheck"]);
  check("unit-and-api", "npm", ["run", "test:node"]);
  check("bun-api", "npm", ["run", "test:bun"]);
  check("driver-regressions", "npm", ["run", "test:driver"]);
  check("native-regressions", "npm", ["run", "test:native"]);
  check("parity-unit", "npm", ["run", "test:parity:unit"]);
  check("headed-headless-parity", "npm", [
    "run", "test:parity", "--", "--output", "artifacts/parity/release.json",
  ], 7_260_000);
  check("native-profile-parity", "npm", [
    "run", "test:parity", "--", "--native-defaults", "--output", "artifacts/parity/release-native.json",
  ], 7_260_000);
  check("native-window-fullscreen", "npm", ["run", "test:parity:fullscreen"], 240_000);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  evidence.exitCode = evidence.status === "passed" ? 0 : 1;
  evidence.finishedAt = new Date().toISOString();
  save();
}
