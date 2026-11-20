import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIMEOUT_MS, families, probeIds, probes, validateProbes } from "../index.mjs";
import { STATUS, finish, recorder } from "../support.mjs";
import { checkVerdict, summarizeResult } from "../../lib/outcomes.mjs";

const EXPECTED_FAMILIES = ["audio", "compute", "egress", "geometry", "input", "locale", "permissions", "render"];

test("every descriptor satisfies the additional-probe contract", () => {
  const result = validateProbes();
  assert.deepEqual(result.families, EXPECTED_FAMILIES);
  assert.equal(result.ids.length, probes.length);
  for (const probe of probes) {
    assert.match(probe.id, /^[a-z0-9]+\/[a-z0-9-]+$/);
    assert.ok(Number.isInteger(probe.timeoutMs));
    assert.ok(probe.timeoutMs > 0 && probe.timeoutMs <= MAX_TIMEOUT_MS);
    assert.equal(typeof probe.contextOptions, "object");
    assert.equal(typeof probe.run, "function");
  }
});

test("probe ids are unique and discoverable", () => {
  assert.equal(new Set(probeIds).size, probeIds.length);
  assert.deepEqual([...probeIds].sort(), [...new Set(probes.map((probe) => probe.id))].sort());
});

test("families contain the documented new surfaces and no duplicates", () => {
  assert.deepEqual(families, EXPECTED_FAMILIES);
  for (const family of EXPECTED_FAMILIES) {
    assert.ok(probes.some((probe) => probe.family === family), `missing ${family}`);
  }
});

test("descriptors reject invalid ids, duplicate ids and oversized budgets", () => {
  const base = { ...probes[0] };
  assert.throws(() => validateProbes([{ ...base, id: "NoSlash" }]), /invalid probe id/);
  assert.throws(() => validateProbes([base, { ...base }]), /duplicate probe id/);
  assert.throws(() => validateProbes([{ ...base, timeoutMs: MAX_TIMEOUT_MS + 1 }]), /timeoutMs/);
  assert.throws(() => validateProbes([{ ...base, run: undefined }]), /run must be a function/);
});

test("descriptors do not declare script or property injection surfaces", () => {
  const forbidden = ["initScripts", "evaluateOnNewDocument", "nativePropertyOverrides", "injectScript"];
  for (const probe of probes) {
    for (const key of forbidden) assert.ok(!(key in probe), `${probe.id} declares ${key}`);
  }
});

test("check statuses and result shape satisfy the parent runner contract", () => {
  assert.equal(checkVerdict({ name: "pass", passed: true, status: STATUS.pass }), "pass");
  assert.equal(checkVerdict({ name: "fail", passed: false, status: STATUS.fail }), "fail");
  assert.equal(checkVerdict({ name: "unavailable", passed: null, status: STATUS.unavailable }), "unknown");
  assert.equal(checkVerdict({ name: "unknown", passed: null, status: STATUS.coverageUnknown }), "unknown");
  assert.equal(checkVerdict({ name: "unsupported", passed: null, status: STATUS.unsupported }), "unknown");

  const rec = recorder();
  rec.expect("a", true);
  rec.unknown("b", STATUS.unavailable, "missing");
  const summary = summarizeResult(finish(rec, {}));
  assert.deepEqual(summary.counts, { pass: 1, fail: 0, unknown: 1 });
  assert.equal(summary.status, "observed-with-limitations");
});
