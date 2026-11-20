import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredDiagnostics, differences, leafCount, separateDiagnostics, summarize,
} from "./compare.mjs";

test("nested browser observations retain every differing field", () => {
  assert.deepEqual(differences(
    { screen: { width: 1920 }, pointer: ["fine"], focus: true },
    { screen: { width: 800 }, pointer: ["coarse"], focus: false },
  ), [
    { path: "$.focus", headed: true, headless: false },
    { path: "$.pointer[0]", headed: "fine", headless: "coarse" },
    { path: "$.screen.width", headed: 1920, headless: 800 },
  ]);
});

test("missing fields cannot compare equal to null", () => {
  assert.equal(differences({ value: null }, {}).length, 1);
  assert.equal(differences({ value: 0 }, { value: null }).length, 1);
  assert.deepEqual(differences({ value: null }, { value: null }), []);
});

test("leaf counts include arrays and empty capability objects", () => {
  assert.equal(leafCount({ input: [true, false], capabilities: {}, empty: null }), 4);
});

test("equal failures are not a successful parity comparison", () => {
  const failed = { status: "failed", error: "click did not work" };
  const result = summarize([{ headed: { click: failed }, headless: { click: failed } }]);
  assert.equal(result.failures.length, 2);
  assert.equal(result.comparedValues, 0);
});

test("unexecuted and empty matrices fail", () => {
  const passed = { status: "passed", value: true };
  assert.equal(summarize([{ headed: { click: passed }, headless: {} }]).failures.length, 1);
  assert.equal(summarize([{ headed: {}, headless: {} }]).failures.length, 1);
});

test("repeatability is assessed independently of cross-mode parity", () => {
  const observation = (value) => ({ status: "passed", value });
  const result = summarize([
    { headed: { click: observation(1) }, headless: { click: observation(1) } },
    { headed: { click: observation(2) }, headless: { click: observation(2) } },
  ]);
  assert.equal(result.differences.length, 0);
  assert.equal(result.unstable.length, 2);
});

test("declared diagnostics are partitioned with reasons and exact raw data", () => {
  const probe = {
    name: "interactions/scroll-hover",
    diagnostics: {
      pointerOverRaw: "headed X11 window history duplicates boundary events",
      startupDiagnostic: "OS pointer warp before controlled initialization",
    },
  };
  const observation = {
    trusted: true,
    moves: [{ x: 1, y: 2 }],
    pointerOverRaw: { over: true, history: [1, 2, 3] },
    startupDiagnostic: { origin: [0, 0], virtual: [10, 10] },
  };
  const { value, diagnostics } = separateDiagnostics(probe, observation);
  assert.deepEqual(value, { trusted: true, moves: [{ x: 1, y: 2 }] });
  assert.deepEqual(diagnostics, {
    pointerOverRaw: {
      reason: "headed X11 window history duplicates boundary events",
      observed: { over: true, history: [1, 2, 3] },
    },
    startupDiagnostic: {
      reason: "OS pointer warp before controlled initialization",
      observed: { origin: [0, 0], virtual: [10, 10] },
    },
  });
  assert.deepEqual(declaredDiagnostics(probe), probe.diagnostics);
  assert.deepEqual(observation.pointerOverRaw, { over: true, history: [1, 2, 3] }, "the observation must not be mutated");
});

test("only declared keys leave the compared contract", () => {
  const probe = { name: "p", diagnostics: { startupDiagnostic: "OS startup witness" } };
  const left = separateDiagnostics(probe, { trusted: true, pointerOver: 1, startupDiagnostic: "a" });
  const right = separateDiagnostics(probe, { trusted: true, pointerOver: 2, startupDiagnostic: "b" });
  assert.deepEqual(left.value, { trusted: true, pointerOver: 1 });
  assert.deepEqual(differences(left.value, right.value), [
    { path: "$.pointerOver", headed: 1, headless: 2 },
  ]);
});

test("declared diagnostics cannot hide a functional difference or a failure", () => {
  const probe = { name: "p", diagnostics: { raw: "raw OS witness" } };
  const entry = (trusted) => ({
    status: "passed", value: separateDiagnostics(probe, { trusted, raw: 1 }).value,
  });
  const different = summarize([{ headed: { p: entry(true) }, headless: { p: entry(false) } }]);
  assert.equal(different.differences.length, 1);
  const failed = { status: "failed", error: "trusted event missing" };
  const failures = summarize([{ headed: { p: failed }, headless: { p: failed } }]);
  assert.equal(failures.failures.length, 2);
  assert.equal(failures.comparedValues, 0);
});

test("invalid diagnostic declarations fail instead of filtering fields", () => {
  const invalid = [
    [{ diagnostics: ["raw"] }, /must be an object/],
    [{ diagnostics: null }, /must be an object/],
    [{ diagnostics: {} }, /at least one field/],
    [{ diagnostics: { "*": "reason" } }, /top-level observation key/],
    [{ diagnostics: { "...": "reason" } }, /top-level observation key/],
    [{ diagnostics: { "raw.field": "reason" } }, /top-level observation key/],
    [{ diagnostics: { raw: "" } }, /non-empty reason/],
    [{ diagnostics: { raw: "   " } }, /non-empty reason/],
    [{ diagnostics: { raw: "ignore" } }, /needs an explanation/],
    [{ diagnostics: { raw: 42 } }, /non-empty reason/],
  ];
  for (const [descriptor, message] of invalid) {
    assert.throws(() => declaredDiagnostics({ name: "p", ...descriptor }), message);
  }
  const probe = { name: "p", diagnostics: { absent: "reason" } };
  assert.throws(() => separateDiagnostics(probe, { present: 1 }), /missing from its observation/);
  const all = { name: "p", diagnostics: { only: "reason" } };
  assert.throws(() => separateDiagnostics(all, { only: 1 }), /every observation field/);
  assert.throws(() => separateDiagnostics(probe, null), /observation object/);
  assert.throws(() => separateDiagnostics(probe, []), /observation object/);
});

test("unequal objects without enumerable keys are still reported different", () => {
  assert.equal(differences(Object.create(null), {}).length, 1);
});
