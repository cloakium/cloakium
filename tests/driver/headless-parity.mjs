#!/usr/bin/env node
// Local regression for fingerprint defaults and explicit scrollbar overrides.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const loadPackage = createRequire(import.meta.url);
const BINARY = process.env.CLOAKIUM_BINARY_PATH;
if (!BINARY) {
  console.error("CLOAKIUM_BINARY_PATH is required");
  process.exit(2);
}

const SEED = "42424";
const BASE_ARGS = ["--window-size=1280,800", "--webrtc-ip-handling-policy=disable_non_proxied_udp"];
const VIEWPORT = { width: 800, height: 600 };

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>headless-parity</title>
<style>
  html, body { margin: 0; padding: 0; }
  #tall { height: 1600px; }
  #wide { width: 1600px; height: 1px; }
  #canvas { display: block; background: #ffffff; }
  #fieldset { display: block; width: 320px; }
</style></head>
<body>
  <fieldset id="fieldset"><legend id="legend">Native fieldset</legend><p>fieldset content</p></fieldset>
  <canvas id="canvas" width="200" height="100"></canvas>
  <div id="tall"></div>
  <div id="wide"></div>
  <script>
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 200, 100);
    window.__fixtureReady = true;
  </script>
</body></html>`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function loadPlaywright() {
  const override = process.env.CLOAKIUM_PLAYWRIGHT_CORE;
  let directory;
  let module;
  if (override) {
    assert.ok(path.isAbsolute(override), "CLOAKIUM_PLAYWRIGHT_CORE must be an absolute SDK path");
    const entry = path.join(override, "index.js");
    assert.ok(fs.existsSync(entry), `SDK entry is missing: ${entry}`);
    assert.ok(fs.existsSync(path.join(override, "package.json")), `SDK package.json is missing in ${override}`);
    module = loadPackage(entry);
    directory = override;
  } else {
    const packageJsonPath = loadPackage.resolve("playwright-core/package.json");
    directory = path.dirname(packageJsonPath);
    module = loadPackage("playwright-core");
  }
  const packageJsonPath = path.join(directory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const marker = manifest.cloakium;
  assert.ok(marker && marker.patched, `playwright-core at ${directory} is not Cloakium-patched`);
  const bundle = path.join(directory, "lib", "coreBundle.js");
  return {
    chromium: module.chromium,
    sdk: {
      path: directory,
      realpath: fs.realpathSync(directory),
      entry: path.join(directory, "index.js"),
      version: manifest.version,
      patchSet: marker.patchSet,
      coreBundleSha256: sha256(bundle),
    },
  };
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(PAGE);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Dual-stack so localhost and 127.0.0.1 resolve to the fixture.
    server.listen(0, () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runCase(chromium, origin, definition) {
  const args = [...BASE_ARGS, ...definition.args];
  const browser = await chromium.launch({
    executablePath: BINARY,
    headless: definition.headless,
    args,
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--enable-automation"],
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, locale: "en-US", timezoneId: "UTC" });
    try {
      const page = await context.newPage();
      await page.goto(origin + "/", { waitUntil: "load" });
      await page.waitForFunction(() => window.__fixtureReady === true);
      const metrics = await page.evaluate(() => {
        const documentElement = document.documentElement;
        const canvas = document.getElementById("canvas");
        const fieldset = document.getElementById("fieldset");
        const pixels = Array.from(canvas.getContext("2d").getImageData(0, 0, 4, 4).data);
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          clientWidth: documentElement.clientWidth,
          clientHeight: documentElement.clientHeight,
          verticalBar: window.innerWidth - documentElement.clientWidth,
          horizontalBar: window.innerHeight - documentElement.clientHeight,
          bodyScrollWidth: document.body.scrollWidth,
          bodyScrollHeight: document.body.scrollHeight,
          documentScrollWidth: documentElement.scrollWidth,
          documentScrollHeight: documentElement.scrollHeight,
          canvasDisplay: getComputedStyle(canvas).display,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          canvasInk: pixels[3] === 255 && (pixels[0] > 0 || pixels[1] > 0 || pixels[2] > 0),
          fieldsetDisplay: getComputedStyle(fieldset).display,
          fieldsetWidth: Math.round(fieldset.getBoundingClientRect().width),
          legendText: document.getElementById("legend").textContent,
        };
      });
      return { metrics, browserVersion: browser.version() };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function checkFixture(metrics, label) {
  assert.ok(metrics.bodyScrollWidth > VIEWPORT.width, `${label}: fixture must overflow horizontally`);
  assert.ok(metrics.bodyScrollHeight > VIEWPORT.height, `${label}: fixture must overflow vertically`);
  assert.equal(metrics.canvasWidth, 200, `${label}: canvas backing width`);
  assert.equal(metrics.canvasHeight, 100, `${label}: canvas backing height`);
  assert.equal(metrics.canvasDisplay, "block", `${label}: canvas display`);
  assert.ok(metrics.canvasInk, `${label}: canvas pixels must be painted`);
  assert.equal(metrics.fieldsetDisplay, "block", `${label}: fieldset display`);
  assert.ok(metrics.fieldsetWidth > 200, `${label}: fieldset must be laid out`);
  assert.equal(metrics.legendText, "Native fieldset", `${label}: legend text`);
  assert.ok(metrics.documentScrollWidth >= metrics.bodyScrollWidth, `${label}: document scroll width`);
  assert.ok(metrics.documentScrollHeight >= metrics.bodyScrollHeight, `${label}: document scroll height`);
}

function checkBars(metrics, label, expectBars) {
  if (expectBars) {
    assert.ok(metrics.verticalBar > 0, `${label}: native vertical scrollbar expected, got ${metrics.verticalBar}px`);
    assert.ok(metrics.horizontalBar > 0, `${label}: native horizontal scrollbar expected, got ${metrics.horizontalBar}px`);
  } else {
    assert.equal(metrics.verticalBar, 0, `${label}: vertical scrollbar must be hidden`);
    assert.equal(metrics.horizontalBar, 0, `${label}: horizontal scrollbar must be hidden`);
  }
}

async function main() {
  const jsonIndex = process.argv.indexOf("--json");
  const jsonPath = jsonIndex === -1 ? null : process.argv[jsonIndex + 1];
  const { chromium, sdk } = await loadPlaywright();
  const { server, origin } = await startServer();
  const cases = [
    { name: "fingerprint-headless", headless: true, args: [`--fingerprint=${SEED}`], expectBars: true },
    { name: "fingerprint-headless-explicit-hide", headless: true, args: [`--fingerprint=${SEED}`, "--hide-scrollbars"], expectBars: false },
    { name: "stock-headless-no-fingerprint", headless: true, args: [], expectBars: false },
  ];
  const headed = process.env.DISPLAY && process.env.CLOAKIUM_HEADED_REFERENCE === "1"
    ? { name: "fingerprint-headed-reference", headless: false, args: [`--fingerprint=${SEED}`], expectBars: true }
    : null;
  if (headed) cases.push(headed);

  const results = [];
  const failures = [];
  let browserVersion = null;
  try {
    for (const definition of cases) {
      const label = definition.name;
      try {
        const { metrics, browserVersion: version } = await runCase(chromium, origin, definition);
        browserVersion = version;
        checkFixture(metrics, label);
        checkBars(metrics, label, definition.expectBars);
        results.push({ name: label, headless: definition.headless, args: definition.args, metrics, ok: true });
        console.log(`ok   ${label}: bars=${metrics.verticalBar}/${metrics.horizontalBar} canvas=${metrics.canvasWidth}x${metrics.canvasHeight} fieldset=${metrics.fieldsetDisplay}`);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        failures.push({ name: label, error: message });
        results.push({ name: label, headless: definition.headless, args: definition.args, ok: false, error: message });
        console.log(`FAIL ${label}: ${message}`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const fingerprint = results.find((result) => result.name === "fingerprint-headless");
  const headedResult = results.find((result) => result.name === "fingerprint-headed-reference");
  if (headedResult && headedResult.ok && fingerprint && fingerprint.ok) {
    try {
      assert.equal(headedResult.metrics.verticalBar, fingerprint.metrics.verticalBar, "headed reference vertical bar must match fingerprint headless");
      assert.equal(headedResult.metrics.horizontalBar, fingerprint.metrics.horizontalBar, "headed reference horizontal bar must match fingerprint headless");
      console.log(`ok   headed reference matches fingerprint headless: bars=${headedResult.metrics.verticalBar}/${headedResult.metrics.horizontalBar}`);
    } catch (error) {
      failures.push({ name: "headed-reference-match", error: String(error.message) });
      console.log(`FAIL headed reference match: ${error.message}`);
    }
  }

  const report = {
    status: failures.length === 0 ? "passed" : "failed",
    sdk,
    binary: BINARY,
    browserVersion,
    viewport: VIEWPORT,
    cases: results,
    failures,
  };
  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`\nsdk: ${JSON.stringify(report.sdk)}`);
  console.log(`${results.length - failures.length}/${results.length} headless parity checks passed`);
  if (failures.length) process.exit(1);
}

const guardMs = Number(process.env.CLOAKIUM_DRIVER_TIMEOUT_MS || 180_000);
const guard = setTimeout(() => {
  console.error(`headless parity suite timed out after ${Math.round(guardMs / 1000)}s`);
  process.exit(1);
}, guardMs);
guard.unref();

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
