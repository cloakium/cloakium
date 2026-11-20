#!/usr/bin/env node
// Distinguish trusted page fullscreen from native window fullscreen.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  browserLaunchOptions,
  displayReference,
  enterPrivateDisplay,
  startWindowManager,
} from "./display.mjs";
import { startFixture } from "./fixture-server.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const loadPackage = createRequire(import.meta.url);
const BROWSER_ARGS = [
  "--fingerprint=42424",
  "--window-size=1280,800",
  "--window-position=10,10",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
];
const SCREEN = { width: 1920, height: 1080 };
const CASE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 180_000;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fullscreen-reference</title>
<style>
  html, body { margin: 0; padding: 8px; font: 16px/1.5 monospace; }
  #fs-target { width: 160px; height: 90px; background: #90caf9; }
  #fs-target:fullscreen { width: 100%; height: 100%; background: #90caf9; }
  #fs-exit { margin: 8px; }
</style></head>
<body>
  <button id="fs-start" type="button">Fullscreen</button>
  <div id="fs-target"><p>fullscreen target</p><button id="fs-exit" type="button">Exit fullscreen</button></div>
  <script>
    window.__fsEvents = [];
    window.__fsState = "idle";
    window.__fsRequest = null;
    document.addEventListener("fullscreenchange", (event) => {
      const element = document.fullscreenElement;
      window.__fsEvents.push({ element: element ? element.id : null, trusted: event.isTrusted === true });
      window.__fsState = element ? "entered" : "exited";
    });
    document.getElementById("fs-start").addEventListener("click", () => {
      window.__fsState = "pending";
      document.getElementById("fs-target").requestFullscreen().then(
        () => { window.__fsRequest = "fulfilled"; },
        (error) => { window.__fsRequest = "rejected:" + error.name; },
      );
    });
    document.getElementById("fs-exit").addEventListener("click", () => {
      document.exitFullscreen();
    });
  </script>
</body></html>`;

function parseOptions() {
  const options = {
    binary: process.env.CLOAKIUM_BINARY_PATH,
    output: "artifacts/parity/fullscreen.json",
  };
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--help") {
      console.log("node tests/parity/fullscreen.mjs [--binary PATH] [--output PATH]");
      console.log("--binary or CLOAKIUM_BINARY_PATH must select the tested browser.");
      console.log("Default output: artifacts/parity/fullscreen.json");
      process.exit(0);
    }
    if (arg === "--binary" || arg === "--output") {
      const value = process.argv[index + 1];
      assert.ok(value, `${arg} needs a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadSdk() {
  const packageJsonPath = loadPackage.resolve("playwright-core/package.json");
  const directory = path.dirname(packageJsonPath);
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  assert.ok(manifest.cloakium && manifest.cloakium.patched, `playwright-core at ${directory} is not Cloakium-patched`);
  return {
    path: directory,
    realpath: fs.realpathSync(directory),
    version: manifest.version,
    patchSet: manifest.cloakium.patchSet,
    coreBundleSha256: sha256(path.join(directory, "lib", "coreBundle.js")),
  };
}

const snapshot = (page) => page.evaluate(() => {
  const target = document.getElementById("fs-target");
  const rect = target.getBoundingClientRect();
  return {
    fullscreenElement: document.fullscreenElement ? document.fullscreenElement.id : null,
    fullscreenEnabled: document.fullscreenEnabled,
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
    },
    screenX,
    screenY,
    screenLeft,
    screenTop,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    visual: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
    targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    devicePixelRatio,
    state: window.__fsState,
    request: window.__fsRequest,
    events: window.__fsEvents.map((event) => ({ element: event.element, trusted: event.trusted })),
  };
});

const twoFrames = (page) => page.evaluate(
  () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
);

function assertRectFills(rect, width, height, label) {
  assert.ok(Math.abs(rect.x) <= 1, `${label}: target x must be 0, got ${rect.x}`);
  assert.ok(Math.abs(rect.y) <= 1, `${label}: target y must be 0, got ${rect.y}`);
  assert.ok(Math.abs(rect.width - width) <= 1, `${label}: target width must be ${width}, got ${rect.width}`);
  assert.ok(Math.abs(rect.height - height) <= 1, `${label}: target height must be ${height}, got ${rect.height}`);
}

function assertRestored(after, before, label) {
  for (const key of ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "screenX", "screenY", "screenLeft", "screenTop", "clientWidth", "clientHeight"]) {
    assert.equal(after[key], before[key], `${label}: ${key} must be restored`);
  }
  assert.deepEqual(after.screen, before.screen, `${label}: screen geometry must be restored`);
  assert.deepEqual(after.visual, before.visual, `${label}: visual viewport must be restored`);
  assert.deepEqual(after.targetRect, before.targetRect, `${label}: target rect must be restored`);
}

function assertUa(snapshotValue, label) {
  assert.equal(snapshotValue.webdriver, false, `${label}: navigator.webdriver must be false`);
  assert.ok(!/Headless/i.test(snapshotValue.userAgent), `${label}: user agent must not expose Headless`);
}

async function runMode(mode, binary, fixture, state) {
  const launch = browserLaunchOptions({ binary, mode });
  if (mode === "headless") {
    assert.ok(!("DISPLAY" in launch.env) && !("WAYLAND_DISPLAY" in launch.env) && !("XAUTHORITY" in launch.env),
      "headless fullscreen must not use a display");
  }
  state.browser = await chromium.launch({ ...launch, args: BROWSER_ARGS });
  const browserVersion = state.browser.version();
  state.context = await state.browser.newContext({ viewport: null, locale: "en-US", timezoneId: "UTC" });
  state.context.setDefaultTimeout(5_000);
  state.context.setDefaultNavigationTimeout(5_000);
  const page = await state.context.newPage();
  const cdp = await state.context.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  const windowBounds = async () => (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
  await page.goto(fixture.origin + "/", { waitUntil: "load" });
  await page.setContent(HTML, { waitUntil: "load" });
  await twoFrames(page);
  const beforeBounds = await windowBounds();
  assert.equal(beforeBounds.windowState, "normal", `${mode}: initial window state`);

  const before = await snapshot(page);
  assert.equal(before.fullscreenElement, null, `${mode}: no fullscreen element before the request`);
  assert.equal(before.fullscreenEnabled, true, `${mode}: fullscreenEnabled`);
  assertUa(before, `${mode} before`);
  assert.equal(before.screen.width, SCREEN.width, `${mode}: configured screen width`);
  assert.equal(before.screen.height, SCREEN.height, `${mode}: configured screen height`);

  await page.locator("#fs-start").click();
  try {
    await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === "fs-target");
  } catch (error) {
    const current = await snapshot(page);
    throw new Error(`${mode}: ${error.message}; state=${JSON.stringify({
      fullscreenElement: current.fullscreenElement,
      state: current.state,
      request: current.request,
      inner: [current.innerWidth, current.innerHeight],
      screen: current.screen,
      events: current.events,
    })}`);
  }
  await twoFrames(page);
  const pageFullscreen = await snapshot(page);
  const pageFullscreenBounds = await windowBounds();
  assert.equal(pageFullscreen.request, "fulfilled", `${mode}: requestFullscreen result`);
  assertUa(pageFullscreen, `${mode} page fullscreen`);
  assertRectFills(pageFullscreen.targetRect, pageFullscreen.innerWidth, pageFullscreen.innerHeight, `${mode} page fullscreen`);

  // Focus emulation can keep page fullscreen inside a visibly captured tab.
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await page.waitForFunction(() => window.innerWidth === screen.width && window.innerHeight === screen.height);
  await twoFrames(page);
  const during = await snapshot(page);
  const duringBounds = await windowBounds();

  assert.equal(during.fullscreenElement, "fs-target", `${mode}: fullscreen element`);
  assert.equal(during.request, "fulfilled", `${mode}: requestFullscreen result`);
  assert.equal(during.screen.width, SCREEN.width, `${mode}: fullscreen screen width`);
  assert.equal(during.screen.height, SCREEN.height, `${mode}: fullscreen screen height`);
  assert.equal(during.innerWidth, SCREEN.width, `${mode}: fullscreen innerWidth`);
  assert.equal(during.innerHeight, SCREEN.height, `${mode}: fullscreen innerHeight`);
  assert.equal(during.clientWidth, SCREEN.width, `${mode}: fullscreen clientWidth`);
  assert.equal(during.clientHeight, SCREEN.height, `${mode}: fullscreen clientHeight`);
  assert.equal(duringBounds.windowState, "fullscreen", `${mode}: fullscreen window state`);
  assert.equal(duringBounds.width, SCREEN.width, `${mode}: fullscreen window width`);
  assert.equal(duringBounds.height, SCREEN.height, `${mode}: fullscreen window height`);
  assertRectFills(during.targetRect, during.innerWidth, during.innerHeight, `${mode} during`);
  assertUa(during, `${mode} during`);
  assert.ok(during.events.some((event) => event.element === "fs-target" && event.trusted === true), `${mode}: trusted fullscreenchange entry`);

  await page.locator("#fs-exit").click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  await page.waitForFunction(() => window.__fsEvents.length >= 2);
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await page.waitForFunction((expected) => (
    document.fullscreenElement === null &&
    window.innerWidth === expected.innerWidth &&
    window.innerHeight === expected.innerHeight &&
    window.outerWidth === expected.outerWidth &&
    window.outerHeight === expected.outerHeight &&
    document.documentElement.clientWidth === expected.clientWidth &&
    document.documentElement.clientHeight === expected.clientHeight
  ), before);
  await twoFrames(page);
  const after = await snapshot(page);
  const afterBounds = await windowBounds();

  assert.equal(after.fullscreenElement, null, `${mode}: fullscreen released`);
  assert.equal(after.state, "exited", `${mode}: fullscreen state after exit`);
  assert.equal(afterBounds.windowState, "normal", `${mode}: restored window state`);
  assert.deepEqual(afterBounds, beforeBounds, `${mode}: window bounds restored`);
  assert.ok(after.events.at(-1).element === null && after.events.at(-1).trusted === true, `${mode}: trusted fullscreenchange exit`);
  assertRestored(after, before, mode);

  return { browserVersion, during, duringBounds, pageFullscreen, pageFullscreenBounds, before, beforeBounds, after, afterBounds };
}

async function main() {
  const options = parseOptions();
  assert.ok(options.binary, "--binary or CLOAKIUM_BINARY_PATH must select the tested browser");
  const binary = fs.realpathSync(options.binary);
  assert.ok(fs.statSync(binary).isFile(), `--binary must be a file: ${binary}`);
  fs.accessSync(binary, fs.constants.X_OK);
  const output = path.resolve(root, options.output);
  assert.ok(!fs.existsSync(output) || fs.statSync(output).isFile(), "--output must be a regular file path");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.accessSync(path.dirname(output), fs.constants.W_OK);
  const sdk = loadSdk();

  await enterPrivateDisplay(script, process.argv.slice(2));
  assert.ok(process.env.DISPLAY, "private display is required for real fullscreen");
  const fixture = await startFixture();
  const states = new Set();
  let wm = null;
  const failures = [];
  let finished = false;

  const cleanupStep = async (label, run, ms) => {
    try { await withTimeout(Promise.resolve().then(run), ms, label); }
    catch (error) { failures.push(`Cleanup failed: ${error.message}`); }
  };
  const closeCase = async (state) => {
    const context = state.context;
    const browser = state.browser;
    state.context = null;
    state.browser = null;
    if (context) await cleanupStep("context close", () => context.close(), 5_000);
    if (browser) await cleanupStep("browser close", () => browser.close(), 5_000);
  };
  const cleanup = async () => {
    for (const state of states) await closeCase(state);
    states.clear();
    if (wm) await cleanupStep("window manager close", () => wm.stop(), 5_000);
    await cleanupStep("fixture close", () => fixture.close(), 5_000);
  };
  const report = {
    status: "failed",
    binary,
    sdk,
    display: displayReference("openbox"),
    screen: SCREEN,
    cases: {},
    actions: {
      pageFullscreen: "trusted click calls requestFullscreen",
      nativeWindowFullscreen: "Browser.setWindowBounds",
    },
    diagnostics: {
      reason: "Headed Openbox frame insets and headless window chrome differ; before/after are retained here, restoration is asserted within each mode, and only fullscreen-during geometry is compared across modes.",
      headed: null,
      headless: null,
    },
    failures,
  };
  const writeReport = () => {
    try {
      const temporary = `${output}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
      fs.renameSync(temporary, output);
      return true;
    } catch (error) {
      console.error(`cannot write ${output}: ${error.message}`);
      return false;
    }
  };
  let watchdog = null;
  let onSignal = null;
  const finish = async (code) => {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (onSignal) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    await cleanup();
    if (code !== 0 && failures.length === 0) failures.push(`fullscreen reference stopped with exit code ${code}`);
    const exitCode = code || (failures.length ? 1 : 0);
    report.failures = failures;
    report.status = exitCode === 0 ? "passed" : "failed";
    const saved = writeReport();
    process.exit(saved ? exitCode : 1);
  };
  watchdog = setTimeout(() => {
    failures.push(`fullscreen reference exceeded ${TOTAL_TIMEOUT_MS} ms`);
    void finish(124);
  }, TOTAL_TIMEOUT_MS);
  watchdog.unref();
  onSignal = (signal) => { void finish(signal === "SIGTERM" ? 143 : 130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    wm = await startWindowManager(path.join(path.dirname(output), "openbox-fullscreen.log"));
    for (const mode of ["headed", "headless"]) {
      const state = { browser: null, context: null };
      states.add(state);
      try {
        report.cases[mode] = await withTimeout(runMode(mode, binary, fixture, state), CASE_TIMEOUT_MS, `${mode} case`);
      } catch (error) {
        failures.push(`${mode}: ${error.message}`);
      } finally {
        await closeCase(state);
        states.delete(state);
      }
    }

    const headed = report.cases.headed;
    const headless = report.cases.headless;
    if (headed && headless) {
      for (const key of ["fullscreenElement", "innerWidth", "innerHeight", "clientWidth", "clientHeight", "userAgent", "request"]) {
        assert.equal(headed.during[key], headless.during[key], `during ${key} must match across modes`);
      }
      assert.deepEqual(headed.during.screen, headless.during.screen, "during screen geometry must match");
      assertRectFills(headed.during.targetRect, headless.during.innerWidth, headless.during.innerHeight, "headed during cross-check");
      assertRectFills(headless.during.targetRect, headed.during.innerWidth, headed.during.innerHeight, "headless during cross-check");
      assertUa(headed.during, "headed during comparison");
      assertUa(headless.during, "headless during comparison");
      assert.equal(headed.duringBounds.windowState, headless.duringBounds.windowState, "during windowState must match");
      assert.equal(headed.duringBounds.width, headless.duringBounds.width, "during window width must match");
      assert.equal(headed.duringBounds.height, headless.duringBounds.height, "during window height must match");
    }
    report.diagnostics.headed = headed ? withInsets(headed.before, headed.after, headed.beforeBounds, headed.afterBounds) : null;
    report.diagnostics.headless = headless ? withInsets(headless.before, headless.after, headless.beforeBounds, headless.afterBounds) : null;
    report.diagnostics.requestFullscreen = {
      reason: "The configured automation session can apply requestFullscreen within a visibly captured tab. Native window fullscreen is requested separately through Browser.setWindowBounds.",
      headed: headed ? { snapshot: headed.pageFullscreen, bounds: headed.pageFullscreenBounds } : null,
      headless: headless ? { snapshot: headless.pageFullscreen, bounds: headless.pageFullscreenBounds } : null,
    };
  } catch (error) {
    failures.push(error.message);
  } finally {
    await finish(failures.length ? 1 : 0);
  }
}

function withInsets(before, after, beforeBounds, afterBounds) {
  return {
    before,
    after,
    bounds: { before: beforeBounds, after: afterBounds },
    insets: {
      before: { width: before.outerWidth - before.innerWidth, height: before.outerHeight - before.innerHeight },
      after: { width: after.outerWidth - after.innerWidth, height: after.outerHeight - after.innerHeight },
    },
  };
}

async function withTimeout(promise, ms, label) {
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
