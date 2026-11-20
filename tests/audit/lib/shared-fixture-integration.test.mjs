// Borrowed shared-origin lifecycle: probe-only suites reuse one runner-owned
// origin, never close it, and keep fresh scenario fixtures independent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSuite } from './suite-execution.mjs';

const SHARED = {
  origin: 'http://127.0.0.1:43001',
  crossOrigin: 'http://[::1]:43001',
  port: 43001,
  receipt: { sha256: 'a'.repeat(64) },
  originStats: () => ({ hits: {}, requests: [] }),
  close() { this.closeCalls = (this.closeCalls ?? 0) + 1; }
};

const OBSERVED = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  appVersion: '5.0 (X11; Linux x86_64)', appName: 'Netscape', appCodeName: 'Mozilla',
  product: 'Gecko', vendor: 'Google Inc.', platform: 'Linux x86_64',
  language: 'en-US', languages: ['en-US'],
  hardwareConcurrency: 8, deviceMemory: 4, maxTouchPoints: 0,
  cookieEnabled: true, onLine: true, pdfViewerEnabled: true, doNotTrack: null, webdriver: false,
  userAgentData: { brands: [{ brand: 'Chromium', version: '157' }], mobile: false, platform: 'Linux' },
  userActivation: { isActive: false, hasBeenActive: false },
  pluginCount: 0, plugins: [], mimeTypes: [], pluginMimesNested: true,
  connection: null, estimate: { quota: 1_000_000_000, usage: 0 }
};

function fakePage() {
  let calls = 0;
  return {
    async goto() { return {}; },
    async evaluate() {
      calls += 1;
      if (calls === 1) return undefined; // prepare()
      return { first: OBSERVED, second: OBSERVED };
    }
  };
}

function world() {
  const calls = { launches: 0, labStarts: 0, labCloses: 0, sharedCloses: 0 };
  const page = fakePage();
  const created = [];
  const browser = {
    contexts() { return created.filter((context) => !context.closed); },
    version: () => '157.0.8103.50',
    async newContext() {
      const context = { closed: false, async newPage() { return page; }, async close() { context.closed = true; }, request: {} };
      created.push(context);
      return context;
    }
  };
  const freshLab = {
    origin: 'http://127.0.0.1:42001',
    crossOrigin: 'http://[::1]:42001',
    crossOriginMode: 'ipv6-loopback-same-port',
    port: 42001,
    originStats: () => ({ hits: {}, requests: [] }),
    close: async () => { calls.labCloses += 1; return { closed: true, errors: [] }; }
  };
  return {
    calls,
    dependencies: {
      startLab: async () => { calls.labStarts += 1; return freshLab; },
      launchBrowser: async () => {
        calls.launches += 1;
        return { browser, pid: 1, transport: 'fixture', sample: async () => ({}), close: async () => { calls.sharedCloses += 0; return { closed: true, remaining: [], limitations: [] }; } };
      },
      inspectSandbox: async () => ({ status: 'confirmed', configured: true }),
      observeEnvironment: async () => ({ language: 'en-US' })
    }
  };
}

const baseOptions = {
  suiteId: 'fingerprint',
  probeIds: ['navigator-core'],
  target: { executablePath: '/fixture/chromium' },
  chromium: { launchPersistentContext: async () => { throw new Error('not used'); } },
  configuration: { id: 'shared', mode: 'headless' },
  environment: { locale: 'en-US', timezoneId: 'UTC' },
  output: '/tmp/opencode/shared-fixture-int',
  launchEnv: { PATH: '/usr/bin' },
  baseArgs: ['--fingerprint=42424']
};

test('a probe-only suite borrows one origin and never closes it', async () => {
  const { dependencies, calls } = world();
  const first = await executeSuite({ ...baseOptions, sharedProbeLab: SHARED }, dependencies);
  assert.equal(calls.labStarts, 0, 'borrowed fixture replaces the fresh lab');
  assert.equal(SHARED.closeCalls ?? 0, 0, 'executor never closes the runner-owned fixture');
  assert.equal(calls.launches, 1);
  const fixture = first.sessions[0].diagnostics.fixture;
  assert.deepEqual(
    { origin: fixture.origin, crossOrigin: fixture.crossOrigin, port: fixture.port, ownership: fixture.ownership },
    { origin: SHARED.origin, crossOrigin: SHARED.crossOrigin, port: SHARED.port, ownership: 'borrowed-owned-runner' }
  );
  assert.equal(fixture.sha256, SHARED.receipt.sha256);
  assert.equal(first.cleanup.closed, true, 'borrowed retention is not a cleanup failure');
  assert.equal(first.cleanup.sharedFixture.borrowed, true);
  assert.equal(first.cleanup.sharedFixture.closed, false);
  assert.equal(first.cleanup.sharedFixture.retainedUntilPlanEnd, true);
  assert.equal(first.cleanup.sharedFixture.ownedBy, 'audit-runner');

  const second = await executeSuite({ ...baseOptions, sharedProbeLab: SHARED }, dependencies);
  assert.equal(second.sessions[0].diagnostics.fixture.origin, first.sessions[0].diagnostics.fixture.origin);
  assert.equal(second.sessions[0].diagnostics.fixture.port, first.sessions[0].diagnostics.fixture.port);
  assert.equal(SHARED.closeCalls ?? 0, 0);
});

test('scenario suites ignore the shared fixture and keep fresh fixtures', async () => {
  const { dependencies, calls } = world();
  const result = await executeSuite({
    ...baseOptions,
    suiteId: 'network',
    probeIds: undefined,
    scenarioIds: ['h3-direct'],
    sharedProbeLab: SHARED
  }, dependencies);
  assert.equal(calls.labStarts, 1, 'network starts its own fixture lab');
  assert.equal(calls.sharedCloses, 0);
  assert.equal(SHARED.closeCalls ?? 0, 0);
  assert.equal(result.cleanup.sharedFixture.provided, true);
  assert.equal(result.cleanup.sharedFixture.used, false);
  assert.match(result.cleanup.sharedFixture.reason, /suite-kind-scenarios/);
});

test('standalone probe suites record their own fresh actual origin', async () => {
  const { dependencies, calls } = world();
  const result = await executeSuite(baseOptions, dependencies);
  assert.equal(calls.labStarts, 1);
  assert.equal(calls.labCloses, 1);
  const fixture = result.sessions[0].diagnostics.fixture;
  assert.equal(fixture.origin, 'http://127.0.0.1:42001');
  assert.equal(fixture.port, 42001);
  assert.equal(fixture.ownership, 'suite-owned-fresh');
  assert.equal(result.cleanup.sharedFixture, null);
  assert.equal(result.cleanup.closed, true);
});

test('an invalid shared fixture is rejected before any launch', async () => {
  const { dependencies, calls } = world();
  await assert.rejects(
    executeSuite({ ...baseOptions, sharedProbeLab: { origin: SHARED.origin } }, dependencies),
    /sharedProbeLab\.(crossOrigin|port)/
  );
  assert.equal(calls.launches, 0);
  assert.equal(calls.labStarts, 0);
});
