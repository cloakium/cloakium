import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, privateDirectory, redactText, safeError, serializable } from "./secure-io.mjs";
import { checkVerdict, summarizeResult, bounded } from "./outcomes.mjs";
import { hashFile, hashValue, sourceManifest } from "./hashes.mjs";

async function temporary(work) {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-test-");
  await fs.chmod(root, 0o700);
  try { return await work(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("redaction protects credentials without changing keyboard keys or public hashes", () => {
  assert.ok(!redactText("socks5://test-user:fixture-password@localhost:1").includes("fixture-password"));
  assert.equal(serializable({ key: "A", password: "fixture-only" }).key, "A");
  assert.equal(serializable({ key: "A", password: "fixture-only" }).password, "[REDACTED]");
  assert.equal(serializable({ sha256: "a".repeat(64) }).sha256, "a".repeat(64));
  assert.ok(!redactText("Bearer fixture-only").includes("fixture-only"));
});

test("safe errors do not retain target text or arbitrary error-code secrets", () => {
  const error = Object.assign(new Error("license key: fixture-value"), { code: "FIXTURESECRET" });
  const safe = JSON.stringify(safeError(error, "launch"));
  assert.ok(!safe.includes("fixture-value") && !safe.includes("FIXTURESECRET"));
  assert.equal(safeError(Object.assign(new Error(), { code: "ENOENT" }), "open").code, "ENOENT");
});

test("serialization preserves nonfinite numeric observations and rejects cycles", () => {
  assert.deepEqual(serializable({ value: NaN }), { value: { $number: "NaN" } });
  assert.deepEqual(serializable({ value: Infinity }), { value: { $number: "Infinity" } });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => serializable(cycle), /cycle/);
});

test("private output refuses public directories and existing artifacts", async () => temporary(async root => {
  const publicDir = path.join(root, "public");
  await fs.mkdir(publicDir, { mode: 0o755 });
  await assert.rejects(privateDirectory(publicDir), /0700/);
  const file = path.join(root, "report.json");
  await atomicJson(file, { value: 1 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(atomicJson(file, { value: 2 }), /overwrite/);
  await atomicJson(file, { value: 3 }, { overwrite: true });
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).value, 3);
}));

test("exclusive atomic writes cannot race to replace each other", async () => temporary(async root => {
  const file = path.join(root, "race.json");
  const results = await Promise.allSettled([atomicJson(file, { value: 1 }), atomicJson(file, { value: 2 })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok([1, 2].includes(JSON.parse(await fs.readFile(file, "utf8")).value));
}));

test("symlink output directories are refused", async () => temporary(async root => {
  const alias = path.join(root, "alias");
  await fs.symlink(root, alias);
  await assert.rejects(privateDirectory(alias), /owned/);
}));

test("unavailable checks never become either successful checks or product failures", () => {
  assert.equal(checkVerdict({ name: "gpu", passed: null }), "unknown");
  assert.equal(checkVerdict({ name: "gpu", passed: false, status: "unsupported-by-target" }), "unknown");
  assert.equal(checkVerdict({ name: "wire", passed: false, status: "fail" }), "fail");
  assert.throws(() => checkVerdict({ name: "gpu", passed: true, status: "unavailable" }));
  const result = summarizeResult({ observations: {}, checks: [{ name: "gpu", passed: null }], limitations: [] });
  assert.equal(result.status, "observed-with-limitations");
  assert.deepEqual(result.counts, { pass: 0, fail: 0, unknown: 1 });
});

test("duplicate check names and contradictory verdicts are rejected", () => {
  const check = { name: "same", passed: true };
  assert.throws(() => summarizeResult({ observations: {}, checks: [check, check], limitations: [] }), /duplicate/);
  assert.throws(() => checkVerdict({ name: "bad", passed: null, status: "fail" }), /contradicts/);
});

test("deadlines reject stalled work without leaving a timer", async () => {
  assert.equal(await bounded(() => Promise.resolve(3), 100, "fast"), 3);
  await assert.rejects(bounded(() => new Promise(() => {}), 10, "stalled"), { code: "AUDIT_DEADLINE" });
});

test("source and client hashes change when source content changes", async () => temporary(async root => {
  const file = path.join(root, "entry.mjs");
  await fs.writeFile(file, "export const value = 1;\n");
  const first = await sourceManifest(root, { allFiles: true });
  await fs.writeFile(file, "export const value = 2;\n");
  const second = await sourceManifest(root, { allFiles: true });
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(await hashFile(file), first.files[0].sha256);
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
}));
