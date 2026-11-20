import test from "node:test";
import assert from "node:assert/strict";
import { STATUS, finish, fnv, recorder, remaining, sameNumber } from "../support.mjs";

test("recorder rejects duplicate check names", () => {
  const rec = recorder();
  rec.expect("one", true);
  assert.throws(() => rec.expect("one", false), /recorded twice/);
});

test("finish derives full, partial and unknown coverage", () => {
  const full = recorder();
  full.expect("a", true);
  full.expect("b", false);
  assert.equal(finish(full, {}).coverage, "full");
  assert.equal(finish(full, {}).failed, 1);

  const partial = recorder();
  partial.expect("a", true);
  partial.unknown("b", STATUS.unavailable, "missing");
  assert.equal(finish(partial, {}).coverage, "partial");

  const unknown = recorder();
  unknown.unknown("a", STATUS.unavailable, "missing");
  assert.equal(finish(unknown, {}).coverage, "unknown");
  assert.equal(finish(unknown, {}).failed, 0);
});

test("null checks are never counted as passes or failures", () => {
  const rec = recorder();
  rec.unknown("device", STATUS.unavailable, "no adapter");
  const result = finish(rec, {});
  assert.equal(result.checks[0].passed, null);
  assert.equal(result.failed, 0);
  assert.equal(result.coverage, "unknown");
});

test("fnv is deterministic and distinguishes byte sequences", () => {
  assert.equal(fnv("abc"), fnv("abc"));
  assert.notEqual(fnv("abc"), fnv("abd"));
  assert.match(fnv(new Uint8Array([1, 2, 3])), /^[0-9a-f]{8}$/);
});

test("remaining clamps to the fallback and to at least one second", () => {
  assert.equal(remaining(undefined, 5000), 5000);
  assert.equal(remaining(Date.now() + 60_000, 5000), 5000);
  assert.equal(remaining(Date.now() - 10_000, 5000), 1000);
});

test("sameNumber rejects NaN and respects tolerance", () => {
  assert.equal(sameNumber(1.0000001, 1), true);
  assert.equal(sameNumber(1.01, 1), false);
  assert.equal(sameNumber(Number.NaN, 1), false);
});
