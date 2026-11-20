import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CHECK = path.join(HERE, "check.mjs");

function run(...args) {
  return spawnSync(process.execPath, [CHECK, ...args], {
    cwd: REPO, encoding: "utf8", timeout: 30_000,
  });
}

test("--help is read-only and documents the ten-minute wall clock", () => {
  const result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /600000/);
  assert.match(result.stdout, /--list/);
  assert.match(result.stdout, /No browser/);
});

test("--list is complete, unique and points at real files", () => {
  const result = run("--list");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((line) => /^(test|selfcheck|skip) /.test(line));
  assert.ok(lines.length >= 10, `only ${lines.length} planned commands`);
  const files = lines.map((line) => line.split(/\s+/)[1]);
  assert.equal(new Set(files).size, files.length, "duplicate command path");
  for (const file of files) assert.ok(existsSync(path.join(REPO, file)), file);
  assert.ok(files.includes("tests/audit/fingerprint/tests/contract.test.mjs"));
  assert.ok(files.includes("tests/audit/network/selfcheck/sources.mjs"));
  assert.ok(!files.includes("tests/audit/request-paths/selfcheck/browser.mjs"),
    "the browser probe is not a unit");
});

test("--list never executes a unit", () => {
  const result = run("--list");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.doesNotMatch(result.stdout, /audit units: \d+ commands passed/);
});
