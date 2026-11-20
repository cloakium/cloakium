import test from "node:test";
import assert from "node:assert/strict";
import { canonicalObservation, canonicalCleanup, canonicalError, executionComplete } from "./protocol.mjs";

test("canonical adapter preserves detailed originals and keeps unknowns out of failures", () => {
  const row = canonicalObservation({
    id: "local", suiteId: "network", scenarioId: "socks", family: "network", status: "observed-with-limitations",
    result: { observations: { bytes: 0 }, checks: [
      { name: "relay", passed: false, status: "stage-needed", detail: { fixture: "missing" } },
      { name: "known", passed: false, status: "fail" },
    ], limitations: [{ code: "local", detail: "fixture needed" }] },
  });
  assert.equal(row.id, "network.socks.local");
  assert.equal(row.status, "observed");
  assert.equal(row.result.checks[0].status, "unknown");
  assert.equal(row.result.checks[1].status, "fail");
  assert.deepEqual(row.result.observations.$audit.originalChecks[0].detail, { fixture: "missing" });
  assert.equal(typeof row.result.limitations[0], "string");
});

test("an executed product inconsistency does not become a harness execution error", () => {
  const run = {
    cleanup: canonicalCleanup([{ cleanup: { closed: true } }]),
    observations: [{ status: "observed", result: { checks: [{ passed: false, status: "fail" }] } }],
  };
  assert.equal(executionComplete({ runs: [run], errors: [] }, 1), true);
  assert.equal(executionComplete({ runs: [run], errors: [] }, 2), false);
  assert.equal(canonicalCleanup([{ cleanup: { closed: false } }]).status, "incomplete");
});

test("a missing fixture cannot satisfy executed coverage", () => {
  const row = canonicalObservation({
    id: "h3", suiteId: "network", scenarioId: "direct", family: "network", status: "unavailable",
    result: { observations: {}, checks: [{ name: "fixture", passed: null, status: "stage-needed" }], limitations: [] },
  });
  assert.equal(row.status, "skipped");
  assert.equal(executionComplete({ errors: [], runs: [{ cleanup: { status: "clean" }, observations: [row] }] }, 1), false);
});

test("canonical error operation is a short stable identifier, not a raw message field", () => {
  const error = canonicalError({ scope: "configuration", error: {
    operation: "configuration execution / fixture", category: "operation-failed",
  } }, "fixture");
  assert.equal(error.operation, "configuration-execution-fixture");
  assert.match(error.operation, /^[A-Za-z0-9_.-]{1,64}$/);
});
