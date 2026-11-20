// Unit tests for the pure helpers (no browser, no mocks beyond plain objects).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bounded, finish, recorder, round, sameSet, settle, unique } from '../support/common.mjs';
import { emittedCheckLiterals, limitCodes, scanConsistency } from '../support/scan.mjs';

test('recorder keeps verdicts tri-state', () => {
  const rec = recorder();
  rec.expect('a/pass', true);
  rec.expect('a/fail', false, 'detail');
  rec.unknown('a/gap', 'reason');
  rec.limit('gap-code', 'why');
  assert.deepEqual(rec.checks, [
    { name: 'a/pass', passed: true },
    { name: 'a/fail', passed: false, detail: 'detail' },
    { name: 'a/gap', passed: null, detail: 'reason' }
  ]);
  assert.deepEqual(rec.limitations, [{ code: 'gap-code', detail: 'why' }]);
});

test('recorder refuses two verdicts for one name in a single run', () => {
  const rec = recorder();
  rec.expect('a/one', true);
  assert.throws(() => rec.unknown('a/one', 'second'), /recorded twice/);
  assert.equal(rec.checks.length, 1);
});

test('finish derives coverage and failure count', () => {
  const full = recorder();
  full.expect('x/a', true);
  full.expect('x/b', true);
  assert.equal(finish(full, {}).coverage, 'full');
  assert.equal(finish(full, {}).failed, 0);

  const partial = recorder();
  partial.expect('x/a', true);
  partial.unknown('x/b', 'missing');
  const partialResult = finish(partial, { observed: 1 });
  assert.equal(partialResult.coverage, 'partial');
  assert.equal(partialResult.failed, 0);
  assert.deepEqual(partialResult.observations, { observed: 1 });

  const unknown = recorder();
  unknown.unknown('x/a', 'missing');
  assert.equal(finish(unknown, {}).coverage, 'unknown');
  assert.equal(finish(unknown, {}).failed, 0);

  const failing = recorder();
  failing.expect('x/a', false);
  assert.equal(finish(failing, {}).failed, 1);
});

test('numeric rounding and set helpers', () => {
  assert.equal(round(1.23456789, 3), 1.235);
  assert.equal(round(Number.NaN), Number.NaN);
  assert.deepEqual(unique(['b', 'a', 'b']), ['b', 'a']);
  assert.equal(sameSet(['a', 'b'], ['b', 'a', 'a']), true);
  assert.equal(sameSet(['a'], ['a', 'b']), false);
});

test('bounded rejects at its deadline and settle converts to a gap', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 20, 'never'), /never exceeded 20 ms/);
  const value = await bounded(Promise.resolve('ok'), 1000, 'fast');
  assert.equal(value, 'ok');
  const gap = await settle(Promise.reject(new Error('boom')), 1000, 'rejecting');
  assert.deepEqual(gap, { ok: false, error: 'boom' });
  const fine = await settle(Promise.resolve(7), 1000, 'fine');
  assert.deepEqual(fine, { ok: true, value: 7 });
});

test('scan detects drift in both directions', () => {
  const source = `
    rec.expect('a/ok', true);
    rec.unknown('a/gap', 'why');
    rec.expect('a/extra', true);
    rec.expect('a/ok', true);
    rec.limit('some-code', 'detail');
    for (const name of ['a/loop']) rec.unknown(name, 'x');
  `;
  const drift = scanConsistency(source, ['a/ok', 'a/gap', 'a/loop', 'a/missing']);
  assert.deepEqual(drift.undeclaredEmitted, ['a/extra']);
  assert.deepEqual(drift.missingInSource, ['a/missing']);
  assert.deepEqual(drift.duplicatesDeclared, []);
  assert.deepEqual(drift.repeatedVerdicts, ['expect:a/ok']);
  assert.deepEqual(
    [...emittedCheckLiterals(source).keys()].sort(),
    ['expect:a/extra', 'expect:a/ok', 'unknown:a/gap']
  );
  assert.deepEqual(limitCodes(source), ['some-code']);
});

test('scan flags duplicate declarations and contract-only names', () => {
  const drift = scanConsistency("rec.expect('a/ok', true);", ['a/ok', 'a/ok']);
  assert.deepEqual(drift.duplicatesDeclared, ['a/ok']);
  const lonely = scanConsistency("const checks = ['a/ok'];\nrec.expect('a/ok', true);", ['a/ok', 'a/never']);
  assert.deepEqual(lonely.declaredOnlyInContract, ['a/never']);
});
