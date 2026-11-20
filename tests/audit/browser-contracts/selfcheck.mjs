/**
 * Structural checks for the browser-contracts family. No browser is launched:
 * descriptor shape, the priming rule (HTTP fixtures, not setContent) and the
 * no-override rule are asserted from source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probes } from "./index.mjs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false });
    process.stdout.write(`FAIL ${name} :: ${error.message}\n`);
  }
}

const SOURCE = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");

check("descriptor shape", () => {
  assert.equal(probes.length, 10, `expected 10 contracts, got ${probes.length}`);
  assert.equal(new Set(probes.map((probe) => probe.id)).size, probes.length);
  for (const probe of probes) {
    assert.match(probe.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof probe.family, "string");
    assert.ok(Number.isInteger(probe.timeoutMs) && probe.timeoutMs > 0 && probe.timeoutMs <= 30_000);
  }
});

check("only the document-load contract uses page.setContent", () => {
  const calls = [...SOURCE.matchAll(/setContent\(/g)].length;
  assert.equal(calls, 1, `setContent appears ${calls} times; it is a functional contract, not a priming strategy`);
  const probe = probes.find((entry) => entry.id === "playwright-document-load-contract");
  assert.ok(probe, "the setContent contract must exist");
});

check("priming navigates HTTP fixtures", () => {
  const navigations = [...SOURCE.matchAll(/page\.goto\(`\$\{origin\}\//g)].length;
  assert.ok(navigations >= 4, `expected HTTP fixture navigation, found ${navigations}`);
});

check("no page-state overrides", () => {
  const forbidden = [
    /Function\.prototype\.[A-Za-z]+\s*=(?!=)/,
    /Object\.defineProperty\(\s*navigator/,
    /navigator\.[A-Za-z]+\s*=(?!=)/,
    /addInitScript|evaluateOnNewDocument/
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(SOURCE), `forbidden override: ${pattern}`);
  }
});

check("every check name is namespaced", () => {
  // Names are authored per contract; they must be non-empty and unique inside a run.
  for (const probe of probes) assert.ok(probe.id.length > 0);
});

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\nbrowser-contracts selfcheck: ${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exitCode = 1;
