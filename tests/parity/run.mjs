import assert from "node:assert/strict";
import {
  accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { declaredDiagnostics, separateDiagnostics, summarize } from "./compare.mjs";
import { browserLaunchOptions, displayReference, enterPrivateDisplay, startWindowManager } from "./display.mjs";
import { startFixture } from "./fixture-server.mjs";

const script = fileURLToPath(import.meta.url);
const directory = resolve(import.meta.dirname);
const root = resolve(directory, "../..");
const loadPackage = createRequire(import.meta.url);
const driver = loadPackage("playwright-core/package.json");
const driverPath = resolve(loadPackage.resolve("playwright-core/package.json"), "..");
const browserArgs = [
  "--fingerprint=42424",
  "--window-size=1280,800",
  "--window-position=10,10",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
];
const options = {
  binary: process.env.CLOAKIUM_BINARY_PATH, output: "artifacts/parity/latest.json",
  repeat: 2, windowManager: "none",
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--report-only") options.reportOnly = true;
  else if (arg === "--native-defaults") options.nativeDefaults = true;
  else if (arg === "--help") {
    console.log("node tests/parity/run.mjs --binary PATH [--output JSON] [--repeat N] [--select PREFIX] [--window-manager none|openbox] [--report-only] [--native-defaults]");
    console.log("The headed reference is a private Xvfb display; the default window manager is none.");
    process.exit(0);
  } else if (arg === "--window-manager") {
    const value = process.argv[++index];
    assert.ok(value, "--window-manager needs a value");
    options.windowManager = value;
  } else if (["--binary", "--output", "--repeat", "--select"].includes(arg)) {
    const value = process.argv[++index];
    assert.ok(value, `${arg} needs a value`);
    options[arg.slice(2)] = arg === "--repeat" ? Number(value) : value;
  } else throw new Error(`Unknown argument ${arg}`);
}
assert.ok(options.binary, "--binary or CLOAKIUM_BINARY_PATH must select the patched browser");
assert.ok(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 5, "--repeat must be 1..5");
const reference = displayReference(options.windowManager);
options.binary = resolveBinary(options.binary);
options.output = resolve(root, options.output);
assert.ok(!existsSync(options.output) || statSync(options.output).isFile(),
  `--output must be a regular file path: ${options.output}`);
const artifactDir = resolve(options.output, "..");
mkdirSync(artifactDir, { recursive: true });
accessSync(artifactDir, fsConstants.W_OK);
const launchDefaults = browserLaunchOptions({
  binary: options.binary, mode: "headless", nativeDefaults: options.nativeDefaults,
});

function resolveBinary(value) {
  let binary;
  try { binary = realpathSync(value); }
  catch { throw new Error(`--binary or CLOAKIUM_BINARY_PATH must point to the patched browser: ${value}`); }
  assert.ok(statSync(binary).isFile(), `--binary must point to an executable file: ${binary}`);
  try { accessSync(binary, fsConstants.X_OK); }
  catch { throw new Error(`--binary is not executable: ${binary}`); }
  return binary;
}

async function loadProbes() {
  const probes = [];
  for (const file of readdirSync(resolve(directory, "probes")).filter((file) => file.endsWith(".mjs")).sort()) {
    const module = await import(pathToFileURL(resolve(directory, "probes", file)).href);
    probes.push(...(module.probes ?? []));
  }
  const selected = probes.filter((probe) => !options.select || probe.name.startsWith(options.select));
  assert.ok(selected.length > 0, "No parity probes selected");
  assert.equal(new Set(selected.map((probe) => probe.name)).size, selected.length, "Probe names must be unique");
  for (const probe of selected) {
    assert.equal(typeof probe.run, "function", `${probe.name} must export a run function`);
    declaredDiagnostics(probe);
  }
  return selected;
}

async function closeContext(context) {
  let timer;
  try {
    return await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("context.close() exceeded 10000 ms")), 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

// Probe and CLI validation run before the harness takes over a private display,
// so bad options and empty selections fail without starting Xvfb or a browser.
let probes;
try {
  probes = await loadProbes();
  await enterPrivateDisplay(script, process.argv.slice(2));
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exit(1);
}

const report = {
  schemaVersion: 1,
  binary: options.binary,
  startedAt: new Date().toISOString(),
  upstream: JSON.parse(readFileSync(resolve(root, "upstream.json"), "utf8")),
  playwright: {
    version: driver.version, path: driverPath, marker: driver.cloakium,
    patchManifest: JSON.parse(readFileSync(resolve(driverPath, "CLOAKIUM-PATCHES.json"), "utf8")),
  },
  reference,
  configuration: {
    seed: "42424", viewport: { width: 1000, height: 700 }, sandbox: true,
    args: browserArgs, ignoredDriverArgs: launchDefaults.ignoreDefaultArgs,
    headlessDisplay: "unset", nativeDefaults: options.nativeDefaults ?? false,
  },
  probes: probes.map((probe) => probe.name),
  runs: [],
  status: "running",
};
function save() {
  const temporary = `${options.output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, options.output);
}
async function bounded(run, timeoutMs, name) {
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
let manager;
let fixture;
try {
  if (options.windowManager === "openbox") manager = await startWindowManager(resolve(artifactDir, "openbox.log"));
  fixture = await startFixture();
  for (let iteration = 0; iteration < options.repeat; iteration++) {
    const run = { headed: {}, headless: {}, environment: {} };
    report.runs.push(run);
    const modes = iteration % 2 ? ["headless", "headed"] : ["headed", "headless"];
    for (const mode of modes) {
      const launch = browserLaunchOptions({
        binary: options.binary, mode, nativeDefaults: options.nativeDefaults,
      });
      if (mode === "headless") {
        assert.ok(!("DISPLAY" in launch.env) && !("WAYLAND_DISPLAY" in launch.env) && !("XAUTHORITY" in launch.env),
          "Headless launches must not inherit a display environment");
      }
      run.environment[mode] = {
        display: launch.env.DISPLAY ?? null,
        waylandDisplay: launch.env.WAYLAND_DISPLAY ?? null,
        xauthority: launch.env.XAUTHORITY ?? null,
      };
      const browser = await chromium.launch({ ...launch, args: browserArgs });
      try {
        report.browserVersion = browser.version();
        for (const probe of probes) {
          const started = Date.now();
          const context = await browser.newContext({
            viewport: { width: 1000, height: 700 }, locale: "en-US", timezoneId: "UTC",
            ...probe.contextOptions,
          });
          context.setDefaultTimeout(5_000);
          context.setDefaultNavigationTimeout(5_000);
          try {
            const raw = await bounded(() => probe.run({
              browser, context, origin: fixture.origin, crossOrigin: fixture.crossOrigin, artifactDir,
            }), probe.timeoutMs ?? 20_000, probe.name);
            assert.notEqual(raw, undefined, `${probe.name} must return observations`);
            const { value, diagnostics } = separateDiagnostics(probe, raw);
            const compared = JSON.parse(JSON.stringify(value));
            const evidence = diagnostics === undefined ? undefined : JSON.parse(JSON.stringify(diagnostics));
            const observation = { status: "passed", value: compared, durationMs: Date.now() - started };
            if (evidence !== undefined) observation.diagnostics = evidence;
            run[mode][probe.name] = observation;
            console.log(`${iteration + 1} ${mode} ${probe.name}: passed`);
          } catch (error) {
            run[mode][probe.name] = { status: "failed", error: error.stack ?? String(error), durationMs: Date.now() - started };
            console.error(`${iteration + 1} ${mode} ${probe.name}: ${error.message}`);
          } finally {
            try { await closeContext(context); }
            catch (error) {
              console.error(`${probe.name}: context cleanup failed: ${error.message}`);
              const observation = run[mode][probe.name];
              if (observation?.status === "passed") {
                Object.assign(observation, { status: "failed", error: `Context cleanup failed: ${error.stack ?? error}` });
              }
            }
            save();
          }
        }
      } finally { await browser.close(); }
    }
  }
  const result = summarize(report.runs);
  Object.assign(report, result);
  report.status = result.failures.length ? "failed" :
    result.unstable.length ? "unstable" : result.differences.length ? "different" : "passed";
  for (const difference of result.differences) {
    console.log(`DIFFERENT ${difference.probe}: ${difference.fields.map((field) => field.path).join(", ")}`);
  }
  console.log(JSON.stringify({
    status: report.status, probes: report.probes.length, iterations: options.repeat,
    comparedValues: result.comparedValues, differences: result.differences.length,
    unstable: result.unstable.length, failures: result.failures.length, output: options.output,
  }));
  if (result.failures.length || result.unstable.length || (!options.reportOnly && result.differences.length)) process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  try { save(); }
  finally {
    if (fixture) await fixture.close().catch((error) => console.error(`Fixture cleanup failed: ${error.message}`));
    if (manager) await manager.stop().catch((error) => console.error(`Window manager cleanup failed: ${error.message}`));
  }
}
