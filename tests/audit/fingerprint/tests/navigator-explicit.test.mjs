// Requested-value contract for navigator-core: only the declared fields yield
// explicit checks, and a wrong value must never pass. No browser is launched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { probes } from '../navigator/core.mjs';

const probe = probes[0];

function observed(overrides = {}) {
  return {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    appVersion: '5.0 (X11; Linux x86_64)', appName: 'Netscape', appCodeName: 'Mozilla',
    product: 'Gecko', vendor: 'Google Inc.', platform: 'Linux x86_64',
    language: 'en-US', languages: ['en-US'],
    hardwareConcurrency: 8, deviceMemory: 4, maxTouchPoints: 0,
    cookieEnabled: true, onLine: true, pdfViewerEnabled: true, doNotTrack: null, webdriver: false,
    userAgentData: { brands: [{ brand: 'Chromium', version: '157' }], mobile: false, platform: 'Linux' },
    userActivation: { isActive: false, hasBeenActive: false },
    pluginCount: 0, plugins: [], mimeTypes: [], pluginMimesNested: true,
    connection: null, estimate: { quota: 1_000_000_000, usage: 0 },
    ...overrides
  };
}

function fakePage(first = observed()) {
  let calls = 0;
  return {
    async goto() { return {}; },
    async evaluate() {
      calls += 1;
      if (calls === 1) return undefined; // prepare()
      return { first, second: first };
    }
  };
}

async function run(config = {}, first = observed()) {
  const result = await probe.run({ page: fakePage(first), origin: 'http://127.0.0.1:1', config });
  const byName = new Map(result.checks.map((check) => [check.name, check]));
  return { result, byName };
}

test('no expectedNavigator keeps the unchanged normal contract', async () => {
  const { result, byName } = await run();
  assert.equal(result.observations.expectedNavigator.source, 'not-declared');
  for (const name of byName.keys()) assert.ok(!name.startsWith('navigator/explicit-'), `unexpected ${name}`);
});

test('declared requested values are asserted exactly', async () => {
  const { result, byName } = await run({ expectedNavigator: { hardwareConcurrency: 8, deviceMemory: 4, maxTouchPoints: 0, language: 'en-US' } });
  for (const name of [
    'navigator/explicit-hardware-concurrency-matches',
    'navigator/explicit-device-memory-matches',
    'navigator/explicit-max-touch-points-matches',
    'navigator/explicit-language-matches'
  ]) {
    assert.equal(byName.get(name)?.passed, true, name);
  }
  assert.equal(result.observations.expectedNavigator.source, 'config-declared');
  assert.equal(result.observations.expectedNavigator.evaluated.length, 4);
  assert.ok(result.observations.expectedNavigator.evaluated.every((entry) => entry.status === 'match'));
});

test('a wrong requested value fails, never passes on sane=true', async () => {
  const { byName } = await run({ expectedNavigator: { hardwareConcurrency: 12, deviceMemory: 8 } });
  assert.equal(byName.get('navigator/explicit-hardware-concurrency-matches').passed, false);
  assert.equal(byName.get('navigator/explicit-device-memory-matches').passed, false);
});

test('a non-primitive request is unknown with a reason, not a pass', async () => {
  const { result, byName } = await run({ expectedNavigator: { hardwareConcurrency: { value: 8 } } });
  const check = byName.get('navigator/explicit-hardware-concurrency-matches');
  assert.equal(check.passed, null);
  assert.match(String(check.detail.reason), /JSON primitive/);
  assert.ok(result.limitations.some((entry) => entry.code === 'explicit-expectation-invalid'));
});

test('an unavailable API is unknown, never a failure and never a pass', async () => {
  const { result, byName } = await run({ expectedNavigator: { deviceMemory: 4 } }, observed({ deviceMemory: null }));
  const check = byName.get('navigator/explicit-device-memory-matches');
  assert.equal(check.passed, null);
  assert.match(String(check.detail.reason), /not exposed/);
  assert.ok(result.limitations.some((entry) => entry.code === 'explicit-field-unavailable'));
});

test('unsupported expectation keys are recorded as a limitation only', async () => {
  const { result, byName } = await run({ expectedNavigator: { screenWidth: 1920, hardwareConcurrency: 8 } });
  assert.equal(byName.get('navigator/explicit-hardware-concurrency-matches').passed, true);
  assert.ok(result.limitations.some((entry) => entry.code === 'explicit-expectation-unsupported-field'));
});

test('the probe contract declares the conditional check names', () => {
  for (const name of [
    'navigator/explicit-hardware-concurrency-matches',
    'navigator/explicit-device-memory-matches',
    'navigator/explicit-max-touch-points-matches',
    'navigator/explicit-language-matches'
  ]) {
    assert.ok(probe.contract.checks.includes(name), name);
    assert.ok(probe.contract.conditionalChecks[name], `${name} conditional metadata`);
  }
});
