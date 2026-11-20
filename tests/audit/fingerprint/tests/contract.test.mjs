// Contract tests: descriptor shape, declared-check drift and authoring rules.
//
// These run in plain Node with no browser. They do not prove runtime behaviour;
// they prove the suite is well-formed and stays clean-room (no init scripts, no
// property overrides, no randomness, no external URLs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { probes } from '../index.mjs';
import { comparison, configRows, optionalChecks, outOfScope } from '../mapping.mjs';
import { manifest, probeIds } from '../manifest.mjs';
import { mapProbeSources, scanConsistency } from '../support/scan.mjs';

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CHECK = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;

const FORBIDDEN = [
  [/Object\.defineProperty/, 'Object.defineProperty is a page-state override'],
  [/addInitScript|evaluateOnNewDocument|addScriptTag/, 'init scripts are not allowed'],
  [/navigator\.[A-Za-z]+\s*=(?!=)/, 'navigator property assignment'],
  [/window\.[A-Za-z]+\s*=(?!=)/, 'window property assignment'],
  [/Math\.random\s*\(/, 'nondeterministic randomness'],
  [/Date\.now\s*\(/, 'wall-clock value must not influence observations'],
  [/\bhttps?:\/\//, 'external URL literal']
];

test('probe ids are unique and well-formed', () => {
  const ids = probes.map((probe) => probe.id);
  assert.equal(new Set(ids).size, ids.length, 'probe ids must be unique');
  for (const id of ids) assert.match(id, ID);
});

test('every descriptor declares the required shape', () => {
  for (const probe of probes) {
    assert.equal(typeof probe.run, 'function', `${probe.id} must export run`);
    assert.equal(typeof probe.family, 'string', `${probe.id} needs a family`);
    assert.ok(Number.isInteger(probe.budgetMs) && probe.budgetMs > 0, `${probe.id} needs budgetMs`);
    assert.ok(probe.budgetMs <= 20_000, `${probe.id} budgetMs must not exceed 20s`);
    const contract = probe.contract;
    assert.ok(contract && typeof contract === 'object', `${probe.id} needs a contract`);
    for (const key of ['origin', 'crossOrigin', 'routes', 'permissions', 'activation', 'viewport', 'notes']) {
      assert.ok(key in contract, `${probe.id} contract.${key} missing`);
    }
    assert.ok(Array.isArray(contract.checks) && contract.checks.length > 0, `${probe.id} needs declared checks`);
    assert.ok(Array.isArray(contract.routes) && Array.isArray(contract.permissions));
    for (const name of contract.checks) assert.match(name, CHECK, `${probe.id} check ${name}`);
  }
});

test('declared checks match the checks the module can emit', () => {  const sources = mapProbeSources(probes);
  for (const probe of probes) {
    const entry = sources.get(probe.id);
    assert.ok(entry, `${probe.id} must be declared in exactly one module`);
    const drift = scanConsistency(entry.source, probe.contract.checks);
    assert.deepEqual(drift.undeclaredEmitted, [], `${probe.id}: emitted but undeclared`);
    assert.deepEqual(drift.missingInSource, [], `${probe.id}: declared but absent from module`);
    assert.deepEqual(drift.duplicatesDeclared, [], `${probe.id}: duplicate declaration`);
    // Names may appear under both verbs for mutually exclusive branches; the
    // recorder itself throws if two verdicts execute in one run.
    assert.deepEqual(drift.declaredOnlyInContract, [], `${probe.id}: declared but never recorded`);
  }
});

test('timeouts and context options are harness-ready', () => {
  for (const probe of probes) {
    assert.ok(Number.isInteger(probe.timeoutMs), `${probe.id} needs an integer timeoutMs`);
    assert.ok(probe.timeoutMs > 0 && probe.timeoutMs <= 20_000, `${probe.id} timeoutMs must be <= 20000`);
    assert.equal(probe.budgetMs, probe.timeoutMs, `${probe.id} budgetMs must mirror timeoutMs`);
    assert.deepEqual(probe.contextOptions, {}, `${probe.id} declares no context overrides`);
  }
});

test('run rejects with ProbeDeadlineError past the caller deadline', async () => {
  const probe = probes[0];
  await assert.rejects(
    probe.run({
      page: null,
      context: null,
      browser: null,
      origin: 'http://127.0.0.1:1',
      crossOrigin: 'http://localhost:1',
      lab: {},
      config: {},
      deadline: Date.now() - 1
    }),
    (error) => error.name === 'ProbeDeadlineError' && error.code === 'deadline-exceeded'
  );
});

test('harness mapping covers every probe and never invents checks', () => {
  for (const probe of probes) {
    const map = comparison.probes[probe.id];
    assert.ok(map, `${probe.id} needs a comparison entry`);
    assert.ok(map.module.endsWith('.mjs'), `${probe.id} comparison entry needs a module`);
    const optional = optionalChecks[probe.id];
    assert.ok(Array.isArray(optional), `${probe.id} needs an optionalChecks entry`);
    for (const name of optional) {
      assert.ok(probe.contract.checks.includes(name), `${probe.id} optional check ${name} must be declared`);
    }
  }
  assert.ok(configRows.length > 0);
  assert.ok(outOfScope.some((entry) => entry.area === 'cdp'));
  for (const key of Object.keys(comparison.probes)) {
    assert.ok(probes.some((probe) => probe.id === key), `mapping references unknown probe ${key}`);
  }
});

test('audio probe treats offline rendering as compute-bound', () => {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '../render/audio-offline.mjs');
  const source = readFileSync(here, 'utf8');
  assert.match(source, /renderedSeconds/, 'audio probe must report renderedSeconds');
  assert.match(source, /not realtime/i, 'audio probe must state offline rendering is not realtime');
  assert.ok(!/realtimeFactor|wallClock|performance\.now/.test(source), 'audio probe must not measure wall clock');
});

test('every module is harness-ready when imported directly', async () => {
  const sources = mapProbeSources(probes);
  for (const probe of probes) {
    const entry = sources.get(probe.id);
    assert.ok(entry, `${probe.id} must resolve to a module`);
    const module = await import(`file://${entry.file}`);
    const descriptor = module.probes.find((candidate) => candidate.id === probe.id);
    assert.ok(descriptor, `${probe.id} must be exported by ${entry.file}`);
    assert.ok(Number.isInteger(descriptor.timeoutMs), `${probe.id} module export needs timeoutMs`);
    assert.ok(descriptor.timeoutMs > 0 && descriptor.timeoutMs <= 20_000, `${probe.id} timeoutMs range`);
    assert.equal(typeof descriptor.contextOptions, 'object');
    assert.equal(typeof descriptor.run, 'function');
  }
});

test('modules stay clean-room and deterministic', () => {
  const sources = mapProbeSources(probes);
  const seen = new Set();
  for (const [id, { file, source }] of sources) {
    seen.add(id);
    // The SVG namespace URI is an XML identifier, never a network fetch.
    const scrubbed = source.replaceAll('http://www.w3.org/2000/svg', 'urn:svg-namespace');
    for (const [pattern, reason] of FORBIDDEN) {
      assert.ok(!pattern.test(scrubbed), `${id} (${file}): ${reason}`);
    }
    assert.ok(!/from ['"]node:/.test(source), `${id}: probe modules must not import Node builtins`);
  }
  for (const probe of probes) assert.ok(seen.has(probe.id), `${probe.id} has no module`);
});

test('manifest mirrors the descriptors', () => {
  assert.deepEqual(manifest.probes.map((entry) => entry.id), probeIds);
  for (const entry of manifest.probes) {
    const probe = probes.find((candidate) => candidate.id === entry.id);
    assert.deepEqual(entry.checks, probe.contract.checks);
    assert.ok(entry.module && entry.module.endsWith('.mjs'), `${entry.id} needs a module path`);
    assert.ok(Array.isArray(entry.unsupportedStates));
  }
  assert.equal(manifest.budgets.suiteMaxMs, probes.reduce((total, probe) => total + probe.budgetMs, 0));
  assert.ok(manifest.budgets.recommendedGlobalMs > manifest.budgets.suiteMaxMs);
});

test('every probe has at least one hard requirement and honest gap handling', () => {
  const sources = mapProbeSources(probes);
  for (const probe of probes) {
    const source = sources.get(probe.id).source;
    assert.ok(/rec\.expect\(/.test(source), `${probe.id} must assert at least one hard requirement`);
    if (/rec\.unknown\(/.test(source)) {
      assert.ok(/rec\.limit\(/.test(source), `${probe.id} must explain every unknown state`);
    }
  }
});
