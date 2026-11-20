// Optional smoke runner for the additional probes.
//
// It launches a caller-supplied Chromium headless binary against two loopback
// fixtures. It is not part of the default test script and is not an audit result:
// it only proves that every probe can execute and clean up on this host.
//
//   CLOAKIUM_AUDIT_BINARY=/path/to/chromium node tests/audit/additional/tests/smoke.mjs
//
// No external network, no fixture content priming with page.setContent.

import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { probes } from "../index.mjs";

const binary = process.env.CLOAKIUM_AUDIT_BINARY;
if (!binary) {
  console.log("skip: set CLOAKIUM_AUDIT_BINARY to a Chromium executable");
  process.exit(0);
}
const only = process.env.CLOAKIUM_AUDIT_ONLY ? new RegExp(process.env.CLOAKIUM_AUDIT_ONLY) : null;
const verbose = process.env.CLOAKIUM_AUDIT_VERBOSE === "1";
const launchArgs = process.env.CLOAKIUM_AUDIT_ARGS ? process.env.CLOAKIUM_AUDIT_ARGS.split(/\s+/).filter(Boolean) : [];
const headless = process.env.CLOAKIUM_AUDIT_HEADED !== "1";
const viewport = process.env.CLOAKIUM_AUDIT_VIEWPORT === "null" ? null : { width: 1000, height: 700 };
const locale = process.env.CLOAKIUM_AUDIT_LOCALE ?? "en-US";
const timezoneId = process.env.CLOAKIUM_AUDIT_TIMEZONE ?? "UTC";

const HTML = "<!doctype html><html><head><meta charset=utf-8><title>additional probe fixture</title></head><body><p>fixture</p></body></html>";

function startFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

const first = await startFixture();
const second = await startFixture();
let browser = null;
const results = [];
const started = Date.now();
try {
  browser = await chromium.launch({ executablePath: binary, headless, args: launchArgs });
  const context = await browser.newContext({
    viewport, locale, timezoneId,
  });
  for (const probe of probes) {
    if (only && !only.test(probe.id)) continue;
    const page = await context.newPage();
    const probeStarted = Date.now();
    try {
      const result = await Promise.race([
        probe.run({
          page, context, browser, origin: first.origin, crossOrigin: second.origin,
          config: {}, deadline: Date.now() + probe.timeoutMs,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`probe exceeded ${probe.timeoutMs} ms`)), probe.timeoutMs)),
      ]);
      const failed = result.checks.filter((check) => check.passed === false);
      const unknown = result.checks.filter((check) => check.passed === null);
      results.push({
        id: probe.id, ok: true, coverage: result.coverage, checks: result.checks.length,
        failed: failed.map((check) => check.name), unknown: unknown.map((check) => `${check.name} [${check.status}]`),
        durationMs: Date.now() - probeStarted,
        ...(verbose ? { observations: result.observations, checkRows: result.checks, limitations: result.limitations } : {}),
      });
      console.log(`${probe.id}: ok coverage=${result.coverage} checks=${result.checks.length} failed=${failed.length} unknown=${unknown.length} (${Date.now() - probeStarted} ms)`);
    } catch (error) {
      results.push({ id: probe.id, ok: false, error: error.stack ?? String(error), durationMs: Date.now() - probeStarted });
      console.error(`${probe.id}: ERROR ${error.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => first.server.close(resolve));
  await new Promise((resolve) => second.server.close(resolve));
}

const summary = {
  binary,
  durationMs: Date.now() - started,
  probes: results.length,
  errors: results.filter((result) => !result.ok).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.errors > 0) process.exitCode = 1;
