#!/usr/bin/env node
// Local driver fixtures; CLOAKIUM_PLAYWRIGHT_CORE can select a package.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runPersistentChecks } from "./persistent.mjs";

const require = createRequire(import.meta.url);
const BINARY = process.env.CLOAKIUM_BINARY_PATH;
const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];
const expectedVersion =
  process.env.CLOAKIUM_EXPECTED_PLAYWRIGHT_VERSION ??
  JSON.parse(fs.readFileSync(new URL("../../upstream.json", import.meta.url), "utf8")).playwright.version;

async function loadPlaywright() {
  const override = process.env.CLOAKIUM_PLAYWRIGHT_CORE;
  if (override) {
    const packageJsonPath = path.join(override, "package.json");
    return { module: require(path.join(override, "index.js")), packageJsonPath };
  }
  const module = await import("playwright-core");
  return { module, packageJsonPath: require.resolve("playwright-core/package.json") };
}

const results = [];
let counter = 0;

async function test(name, fn) {
  counter += 1;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok ${counter} - ${name}${formatDetail(detail)} (${Date.now() - started}ms)`);
  } catch (error) {
    const message = String((error && error.message) || error).replace(/\s*\n\s*/g, " | ").slice(0, 500);
    results.push({ name, ok: false, error: message });
    console.log(`not ok ${counter} - ${name}: ${message}`);
  }
}

function formatDetail(detail) {
  if (detail === undefined) return "";
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return ` [${text.slice(0, 120)}]`;
}

const PAGES = {
  main: `<!doctype html>
<html><head><title>cloakium-driver</title></head>
<body>
  <h1 id="heading">cloakium</h1>
  <button id="counter" type="button">0</button>
  <div id="host"></div>
  <script>
    window.__initScriptSeen = window.__initScriptSeen || "no-init-script";
    document.getElementById("counter").addEventListener("click", (event) => {
      event.target.textContent = String(Number(event.target.textContent) + 1);
    });
    const shadow = document.getElementById("host").attachShadow({ mode: "open" });
    shadow.innerHTML = '<p id="shadowed">inside-shadow</p>';
    window.spawnWorker = () => new Promise((resolve, reject) => {
      const blob = new Blob(["self.onmessage = (e) => self.postMessage(e.data * 3);"], { type: "text/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error("worker error: " + event.message));
      worker.postMessage(7);
    });
    window.registerServiceWorker = async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      return true;
    };
  </script>
</body></html>`,
  crossSite: `<!doctype html><title>cross-site</title><p id="marker">cross-site-frame</p>`,
  sw: "self.addEventListener('install', () => self.skipWaiting());",
};

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(PAGES.sw);
      return;
    }
    if (request.url === "/json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.headers.host && request.headers.host.startsWith("localhost:") ? PAGES.crossSite : PAGES.main);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  if (!BINARY) {
    console.error("CLOAKIUM_BINARY_PATH must point at the patched Chromium executable");
    process.exit(2);
  }
  if (!fs.existsSync(BINARY)) {
    console.error(`CLOAKIUM_BINARY_PATH does not exist: ${BINARY}`);
    process.exit(2);
  }

  const loaded = await loadPlaywright();
  const { chromium } = loaded.module;
  const packageJson = JSON.parse(fs.readFileSync(loaded.packageJsonPath, "utf8"));
  const version = packageJson.version;

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const crossSite = `http://localhost:${port}`;

  const browser = await chromium.launch({
    executablePath: BINARY,
    headless: true,
    args: LAUNCH_ARGS,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));

  await test("playwright-core version", () => {
    assert.equal(version, expectedVersion);
    return version;
  });

  await test("patched package manifest marker", () => {
    const manifest = packageJson;
    assert.ok(manifest.cloakium && manifest.cloakium.patched, "cloakium marker missing");
    assert.equal(manifest.cloakium.version, version);
    return manifest.cloakium.patchSet;
  });

  await test("evaluate on initial about:blank", async () => {
    assert.equal(await page.evaluate(() => 2 + 2), 4);
  });

  await test("navigation and document state", async () => {
    await page.goto(`${base}/`);
    assert.equal(await page.title(), "cloakium-driver");
    assert.equal(await page.locator("#heading").textContent(), "cloakium");
    return page.url();
  });

  await test("locators, role selectors and actions", async () => {
    await page.getByRole("button", { name: "0" }).click();
    assert.equal(await page.locator("#counter").textContent(), "1");
    await page.locator("#counter").click();
    assert.equal(await page.locator("#counter").textContent(), "2");
  });

  await test("shadow DOM piercing", async () => {
    assert.equal(await page.locator("#host p").textContent(), "inside-shadow");
  });

  await test("same-process iframe", async () => {
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "same-process";
      frame.srcdoc = "<p id='inner'>same-process-frame</p>";
      document.body.appendChild(frame);
    });
    let frame;
    for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
      frame = page.frames().find((candidate) => candidate.url() === "about:srcdoc");
      if (!frame) await page.waitForTimeout(100);
    }
    assert.ok(frame, "srcdoc frame missing");
    assert.equal(await frame.evaluate(() => document.getElementById("inner").textContent), "same-process-frame");
    assert.equal(await page.frameLocator("#same-process").locator("#inner").textContent(), "same-process-frame");
  });

  await test("cross-site out-of-process iframe", async () => {
    await page.evaluate((url) => {
      const frame = document.createElement("iframe");
      frame.id = "oopif";
      frame.src = url;
      document.body.appendChild(frame);
    }, crossSite);
    await page.waitForTimeout(600);
    const frame = page.frames().find((candidate) => candidate.url().startsWith(crossSite));
    assert.ok(frame, "OOPIF frame missing");
    assert.equal(await frame.evaluate(() => document.getElementById("marker").textContent), "cross-site-frame");
    assert.equal(await page.frameLocator("#oopif").locator("#marker").textContent(), "cross-site-frame");
  });

  await test("reload keeps execution contexts", async () => {
    await page.reload();
    assert.equal(await page.evaluate(() => document.title), "cloakium-driver");
    await page.reload();
    assert.equal(await page.locator("#heading").textContent(), "cloakium");
    return "reloaded twice";
  });

  await test("evaluate with arguments and JSHandle round trip", async () => {
    const doubled = await page.evaluate((value) => value * 2, 21);
    assert.equal(doubled, 42);
    const handle = await page.evaluateHandle(() => ({ nested: { value: "handle" } }));
    assert.equal(await handle.evaluate((object) => object.nested.value), "handle");
    await handle.dispose();
  });

  await test("addInitScript runs in the page main world", async () => {
    const initContext = await browser.newContext();
    const initPage = await initContext.newPage();
    await initPage.addInitScript(() => {
      window.__initScriptSeen = "yes-init-script";
    });
    await initPage.goto(`${base}/`);
    assert.equal(await initPage.evaluate(() => window.__initScriptSeen), "yes-init-script");
    await initContext.close();
  });

  await test("dedicated worker evaluate", async () => {
    const value = await page.evaluate(() => window.spawnWorker());
    assert.equal(value, 21);
    const workers = page.workers();
    assert.equal(workers.length, 1, `expected one worker, got ${workers.length}`);
    assert.equal(await workers[0].evaluate(() => 1 + 1), 2);
    return { value, workers: workers.length };
  });

  await test("service worker evaluate", async () => {
    await page.evaluate(() => window.registerServiceWorker());
    await page.waitForTimeout(600);
    const workers = context.serviceWorkers();
    assert.ok(workers.length >= 1, "no service worker was reported");
    assert.equal(await workers[0].evaluate(() => 1 + 1), 2);
    return `${workers.length} service worker(s)`;
  });

  await test("exposeFunction before navigation", async () => {
    await page.exposeFunction("cloakAdd", (a, b) => a + b);
    assert.equal(await page.evaluate(() => window.cloakAdd(2, 5)), 7);
  });

  await test("exposeFunction survives navigation", async () => {
    await page.goto(`${base}/?second`);
    assert.equal(await page.evaluate(() => window.cloakAdd(10, 20)), 30);
    return "binding re-registered for the new document";
  });

  await test("route interception and JSON response", async () => {
    const response = await page.request.get(`${base}/json`);
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { ok: true });
    let intercepted = 0;
    await page.route("**/json", async (route) => {
      intercepted += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ routed: true }) });
    });
    const routed = await page.evaluate(async () => (await fetch("/json")).json());
    assert.deepEqual(routed, { routed: true });
    assert.equal(intercepted, 1);
    await page.unroute("**/json");
  });

  await test("navigation redirect", async () => {
    await page.goto(`${base}/redirect`);
    assert.equal(await page.title(), "cloakium-driver");
  });

  await test("setContent and content", async () => {
    await page.setContent("<p id='set-content'>set-content</p>");
    assert.match(await page.content(), /set-content/);
    assert.equal(await page.locator("#set-content").textContent(), "set-content");
    await page.goto(`${base}/`);
  });

  await test("navigation storm keeps contexts fresh", async () => {
    const paths = [];
    for (let index = 0; index < 5; index += 1) {
      await page.goto(`${base}/storm-${index}`);
      paths.push(await page.evaluate(() => location.pathname));
    }
    assert.deepEqual(paths, ["/storm-0", "/storm-1", "/storm-2", "/storm-3", "/storm-4"]);
    await page.goBack();
    assert.equal(await page.evaluate(() => location.pathname), "/storm-3");
    await page.goForward();
    assert.equal(await page.evaluate(() => location.pathname), "/storm-4");
    return `${paths.length} navigations + history`;
  });

  await test("setContent waitUntil variants", async () => {
    await page.setContent("<p id='dc'>dom-content-loaded</p>", { waitUntil: "domcontentloaded" });
    assert.equal(await page.locator("#dc").textContent(), "dom-content-loaded");
    await page.setContent("<p id='ld'>load</p>", { waitUntil: "load" });
    assert.equal(await page.locator("#ld").textContent(), "load");
  });

  await test("popup page", async () => {
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      page.evaluate(() => window.open("about:blank")),
    ]);
    assert.equal(await popup.evaluate(() => 6 * 7), 42);
    await popup.close();
  });

  await runPersistentChecks({ chromium, test, binary: BINARY, args: LAUNCH_ARGS });

  await test("tracing with snapshots", async () => {
    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-trace-")), "trace.zip");
    await context.tracing.start({ snapshots: true, sources: true });
    await page.goto(`${base}/traced`);
    await page.locator("#heading").textContent();
    await context.tracing.stop({ path: tracePath });
    const size = fs.statSync(tracePath).size;
    const header = fs.readFileSync(tracePath).subarray(0, 2).toString("binary");
    assert.equal(header, "PK", "trace file is not a zip archive");
    assert.ok(size > 1000, `trace archive is suspiciously small (${size} bytes)`);
    fs.rmSync(path.dirname(tracePath), { recursive: true, force: true });
    return `${size} bytes`;
  });

  await test("no identifying playwright globals before bindings", async () => {
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(`${base}/`);
    const globals = await freshPage.evaluate(() =>
      Object.getOwnPropertyNames(window).filter((name) => /playwright|pw_|__pw/i.test(name)),
    );
    assert.deepEqual(globals, [], `unexpected globals: ${globals.join(", ")}`);
    await freshContext.close();
  });

  await test("console property is not an instrumentation accessor", async () => {
    const descriptor = await page.evaluate(() => {
      const found = Object.getOwnPropertyDescriptor(window, "console");
      return { accessor: Boolean(found && (found.get || found.set)), type: found && typeof found.value };
    });
    assert.equal(descriptor.accessor, false);
    assert.equal(descriptor.type, "object");
    return descriptor;
  });

  await test("default mode does not install the Runtime domain", async () => {
    await page.evaluate(() => console.log("cloakium-console-probe"));
    await page.evaluate(() => setTimeout(() => { throw new Error("cloakium-page-error"); }, 0));
    await page.waitForTimeout(400);
    assert.deepEqual(consoleMessages, [], `console events leaked: ${consoleMessages.join("|")}`);
    assert.deepEqual(pageErrors, [], `page errors leaked: ${pageErrors.join("|")}`);
    return "console/pageerror events are opt-in";
  });

  await test("navigator.webdriver is not patched from page script", async () => {
    const shape = await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver");
      return {
        webdriver: navigator.webdriver,
        nativeGetter: Boolean(descriptor && typeof descriptor.get === "function"),
        getterSource: descriptor && typeof descriptor.get === "function" ? descriptor.get.toString() : "",
      };
    });
    assert.equal(shape.nativeGetter, true, "webdriver getter was replaced");
    assert.match(shape.getterSource, /\[native code\]/);
    return { webdriver: shape.webdriver, native: true };
  });

  await test("CLOAKIUM_RUNTIME_DOMAIN=1 restores console and pageerror", async () => {
    process.env.CLOAKIUM_RUNTIME_DOMAIN = "1";
    try {
      const runtimeContext = await browser.newContext();
      const runtimePage = await runtimeContext.newPage();
      const messages = [];
      const errors = [];
      runtimePage.on("console", (message) => messages.push(message.text()));
      runtimePage.on("pageerror", (error) => errors.push(String(error.message)));
      await runtimePage.goto(`${base}/`);
      await runtimePage.evaluate(() => console.log("runtime-domain-console"));
      await runtimePage.evaluate(() => setTimeout(() => { throw new Error("runtime-domain-error"); }, 0));
      await runtimePage.waitForTimeout(500);
      assert.ok(messages.includes("runtime-domain-console"), `console event missing: ${messages.join("|")}`);
      assert.ok(errors.some((message) => message.includes("runtime-domain-error")), "pageerror missing");
      await runtimeContext.close();
      return { messages: messages.length, errors: errors.length };
    } finally {
      delete process.env.CLOAKIUM_RUNTIME_DOMAIN;
    }
  });

  await browser.close();
  server.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} driver checks passed`);
  if (failed.length) {
    for (const failure of failed) console.log(`  FAILED: ${failure.name}: ${failure.error}`);
    process.exit(1);
  }
}

const guardMs = Number(process.env.CLOAKIUM_DRIVER_TIMEOUT_MS || 300_000);
const guard = setTimeout(() => {
  console.error(`driver smoke suite timed out after ${Math.round(guardMs / 1000)}s`);
  process.exit(1);
}, guardMs);
guard.unref();

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
