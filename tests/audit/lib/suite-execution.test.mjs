// Executor tests with injected BrowserServer/lab/driver mocks (no browser runs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateSuite, knownSuites, loadSuite } from './suites.mjs';
import { executeSuite } from './suite-execution.mjs';
import { HOST, fakeLab } from './suite-execution.fixtures.mjs';
import {
  argumentNames, assertSafeBaseArgs, effectiveIgnoreDefaultArgs, mergePriorResults, priorVerdict
} from './suite-support.mjs';
const body = () => ({
  headers: { host: HOST }, path: '/echo', search: '', peerPort: 40000,
  receivedAt: Date.now(), method: 'GET', headerNames: ['host']
});
const response = () => ({ status: () => 200, json: async () => body(), text: async () => 'lab' });
const baseOptions = {
  target: { executablePath: '/fixture/chromium' },
  environment: { locale: 'en-US', timezoneId: 'UTC' },
  output: '/tmp/opencode/suite-exec-output',
  launchEnv: { PATH: '/usr/bin' },
  baseArgs: []
};

/** Scripted page: request-path shapes, explicit queue values, or stalled calls. */
function fakePage(plan = {}) {
  const routes = [];
  const page = {
    async goto(url) {
      for (const entry of routes.slice()) {
        if (entry.pattern.test(String(url))) {
          await entry.handler({ fetch: async () => response(), fulfill: async () => {}, abort: async () => {} });
        }
      }
      return response();
    },
    async evaluate(fn) {
      if (plan.hangRemaining === undefined) plan.hangRemaining = plan.hangFirst ?? 0;
      if (plan.hangRemaining > 0) { plan.hangRemaining -= 1; return new Promise(() => {}); }
      if (plan.queue?.length) return plan.queue.shift();
      const source = String(fn);
      if (source.includes('performance.getEntriesByType')) {
        return { requestStart: 1, responseStart: 2, responseEnd: 3, nextHopProtocol: 'http/1.1', transferSize: 10 };
      }
      if (source.includes('fetch(')) return { status: 200, body: body() };
      return null;
    },
    async route(pattern, handler) { routes.push({ pattern, handler }); },
    async unroute(pattern) {
      const index = routes.findIndex((entry) => entry.pattern === pattern);
      if (index >= 0) routes.splice(index, 1);
    },
    waitForLoadState: async () => {},
    async close() {},
    request: { get: async () => response() }
  };
  return page;
}

function fakeBrowser({ plan = {}, failClose = false } = {}) {
  const created = [];
  return {
    created,
    contexts() { return created.filter((context) => !context.closed); },
    version: () => 'fixture-1.0',
    async newContext(options) {
      const page = fakePage(plan);
      const context = {
        options, page, closed: false,
        request: { get: async () => response() },
        async newPage() { return page; },
        async newCDPSession() { throw new Error('no CDP in fixture'); },
        async close() {
          context.closed = true;
          if (failClose) throw new Error('context close failure: close-secret');
        }
      };
      created.push(context);
      return context;
    }
  };
}

function fakeWitness(order) {
  const state = { samples: 0, closed: false };
  return {
    state,
    async sample() { state.samples += 1; },
    async close() {
      state.closed = true;
      order.push('witness-close');
      return { schema: 'fixture-socket-witness', coverage: 'sampled-owned-socket-metadata', samples: state.samples, absenceEstablished: false };
    }
  };
}

function world({ cleanup, plan, failClose, witnessFactory } = {}) {
  const calls = { launches: 0, closes: 0, labs: 0, prelaunch: [], order: [] };
  const browser = fakeBrowser({ plan, failClose });
  const witness = fakeWitness(calls.order);
  return {
    calls, browser, witness,
    dependencies: {
      socketWitnessFactory: witnessFactory ?? (() => witness),
      launchBrowser: async (options) => {
        calls.launches += 1;
        calls.prelaunch.push({ args: options.args, env: options.env, mode: options.mode });
        return {
          browser, pid: 4242, transport: 'fixture-browser-pipe', sample: async () => ({}),
          close: async () => { calls.closes += 1; calls.order.push('browser-close'); return cleanup ?? { closed: true, remaining: [], limitations: [] }; }
        };
      },
      startLab: async () => { calls.labs += 1; return fakeLab(); },
      inspectSandbox: async () => ({ status: 'confirmed', configured: true }),
      observeEnvironment: async () => ({ language: 'en-US', languages: ['en-US'] })
    }
  };
}

test('registry enumerates every registered suite and rejects unknown ids', async () => {
  assert.deepEqual([...knownSuites], [
    'fingerprint', 'wire-identity', 'browser-contracts', 'additional', 'network',
    'request-paths', 'extended-network', 'profile-lifecycle'
  ]);
  const expected = {
    fingerprint: [22, 0], 'wire-identity': [1, 0], 'browser-contracts': [10, 0],
    additional: [8, 0], network: [31, 17], 'request-paths': [5, 5],
    'extended-network': [31, 7], 'profile-lifecycle': [0, 9]
  };
  for (const id of knownSuites) {
    const listed = await enumerateSuite(id);
    assert.equal(listed.probeIds.length, expected[id][0], `${id} probe ids`);
    assert.equal(listed.scenarioIds.length, expected[id][1], `${id} scenario ids`);
    assert.equal(listed.suiteId, id);
  }
  assert.deepEqual((await enumerateSuite('profile-lifecycle', ['launch-contract'])).probeIds, ['launch-contract']);
  assert.equal((await enumerateSuite('additional')).kind, 'probes');
  await assert.rejects(enumerateSuite('does-not-exist'), /Unknown audit suite/);
  await assert.rejects(enumerateSuite('network', ['nope.probe']), /unknown id/);
  await assert.rejects(loadSuite('__proto__'), /Unknown audit suite/);
});

test('network rows use fresh contexts, merged options and redacted launch evidence', async () => {
  const plan = {
    queue: [
      { first: { count: 1 }, second: { count: 1 }, entries: [{ transferSize: 0 }, { transferSize: 0 }] },
      { first: { count: 1 }, second: { count: 2 } },
      { requestStart: 1, responseStart: 2, responseEnd: 3, nextHopProtocol: 'http/1.1', transferSize: 10 }
    ]
  };
  const { dependencies, calls } = world({ plan });
  const result = await executeSuite({
    ...baseOptions, suiteId: 'network', scenarioIds: ['default'],
    probeIds: ['net.cache.fresh-and-no-store', 'net.timing.navigation-metadata'],
    configuration: { id: 'cfg', mode: 'headless', contextOptions: { locale: 'de-DE' } }
  }, dependencies);
  assert.equal(result.aborted, false);
  assert.equal(result.observations.length, 2);
  for (const row of result.observations) {
    assert.equal(row.status, 'observed-with-limitations');
    assert.equal(row.counts.fail, 0);
  }
  assert.equal(calls.launches, 1);
  assert.equal(calls.closes, 1);
  assert.equal(calls.labs, 1);
  const session = result.sessions[0];
  assert.match(session.launch.argsSha256, /^[0-9a-f]{64}$/);
  assert.ok(session.launch.argumentNames.every((name) => name.startsWith('--')));
  assert.ok(!JSON.stringify(session.launch).includes(':dummy-'), 'no credential values in launch evidence');
  assert.equal(session.version, 'fixture-1.0');
  assert.equal(session.sandbox.status, 'confirmed');
  assert.equal(session.environment.language, 'en-US');
  assert.equal(session.cleanup.closed, true);
  assert.equal(result.cleanup.closed, true);
  assert.deepEqual(calls.prelaunch[0].env, { PATH: '/usr/bin' });
});

test('request-path suite runs five probes in each of its five scenarios', async () => {
  const { dependencies, calls } = world();
  const result = await executeSuite({ ...baseOptions, suiteId: 'request-paths', configuration: { id: 'rp', mode: 'headless' } }, dependencies);
  assert.equal(result.observations.length, 25);
  assert.equal(result.sessions.length, 5);
  assert.equal(calls.launches, 5);
  for (const row of result.observations) {
    assert.ok(row.scenarioId.startsWith('rp-'));
    assert.ok(['observed', 'observed-with-limitations'].includes(row.status), `${row.id}: ${row.status}`);
  }
});

test('unavailable fixtures and unknown statuses are never failures', async () => {
  const { dependencies, calls } = world();
  const skipped = await executeSuite({
    ...baseOptions, suiteId: 'network', scenarioIds: ['h3-direct'], configuration: { id: 'h3', mode: 'headless' }
  }, dependencies);
  assert.equal(calls.launches, 0, 'no browser when the fixture is unavailable');
  assert.equal(skipped.observations[0].status, 'unavailable');
  assert.equal(skipped.observations[0].result.checks[0].passed, null);
  assert.equal(skipped.aborted, false);
  const unknown = await executeSuite({
    ...baseOptions, suiteId: 'network', scenarioIds: ['cookies-3pc-restricted'], configuration: { id: 'cdp', mode: 'headless' }
  }, dependencies);
  assert.equal(unknown.observations[0].status, 'observed-with-limitations');
  assert.equal(unknown.observations[0].counts.unknown, 1);
  assert.equal(unknown.observations[0].counts.fail, 0);
});

test('probe errors and deadlines become categorised rows without raw text', async () => {
  const secret = world({ plan: { queue: [Promise.reject(new Error('target-origin-secret-value'))] } });
  const failed = await executeSuite({ ...baseOptions, suiteId: 'wire-identity', configuration: { id: 'w', mode: 'headless' } }, secret.dependencies);
  assert.equal(failed.observations[0].status, 'execution-error');
  assert.equal(failed.observations[0].result.checks[0].passed, null);
  assert.ok(!JSON.stringify(failed).includes('target-origin-secret-value'));
  // The cache probe runs first in `default`; its first evaluate stalls, so the
  // timing probe must still run afterwards on its own fresh context.
  const stalled = world({ plan: { hangFirst: 1 } });
  const deadline = await executeSuite({
    ...baseOptions, suiteId: 'network', scenarioIds: ['default'],
    probeIds: ['net.timing.navigation-metadata', 'net.cache.fresh-and-no-store'],
    configuration: { id: 'deadline', mode: 'headless', probeConfig: { probeTimeoutMs: 15 } }
  }, stalled.dependencies);
  assert.equal(deadline.observations.length, 2);
  assert.equal(deadline.observations[0].id, 'net.cache.fresh-and-no-store');
  assert.equal(deadline.observations[0].error.category, 'timeout');
  assert.equal(deadline.observations[1].status, 'observed-with-limitations');
  assert.equal(deadline.observations[1].counts.fail, 0);
  assert.ok(stalled.browser.created.every((context) => context.closed), 'every probe context closed');
});

test('context and BrowserServer cleanup failures stop further work', async () => {
  const contexts = world({ failClose: true });
  const closed = await executeSuite({
    ...baseOptions, suiteId: 'network', scenarioIds: ['default'],
    probeIds: ['net.cache.fresh-and-no-store', 'net.timing.navigation-metadata'],
    configuration: { id: 'close', mode: 'headless' }
  }, contexts.dependencies);
  assert.equal(contexts.calls.closes, 1);
  assert.equal(closed.observations[0].status, 'execution-error');
  assert.equal(closed.observations[0].cleanup.closed, false);
  assert.equal(closed.observations[1].status, 'unavailable');
  assert.ok(closed.errors.some((entry) => entry.scope === 'context-cleanup'));
  assert.ok(!JSON.stringify(closed).includes('close-secret'));
  const leaking = world({ cleanup: { closed: false, remaining: [{ pid: 1 }], limitations: [] } });
  const locked = await executeSuite({ ...baseOptions, suiteId: 'request-paths', configuration: { id: 'leak', mode: 'headless' } }, leaking.dependencies);
  assert.equal(leaking.calls.launches, 1);
  assert.equal(locked.aborted, true);
  assert.equal(locked.cleanup.closed, false);
  assert.ok(locked.errors.some((entry) => entry.scope === 'browser-cleanup'));
});

test('launch environment is strict and unknown suites launch nothing', async () => {
  const { dependencies, calls } = world();
  await assert.rejects(executeSuite({
    ...baseOptions, launchEnv: { DISPLAY: ':99', XAUTHORITY: '/tmp/xauth' },
    suiteId: 'wire-identity', configuration: { id: 'x', mode: 'headless' }
  }, dependencies), /must not carry a display/);
  await assert.rejects(executeSuite({
    ...baseOptions, suiteId: 'wire-identity', configuration: { id: 'x', mode: 'headed' }
  }, dependencies), /requires an explicit owned DISPLAY/);
  await assert.rejects(executeSuite({
    ...baseOptions, suiteId: 'wire-identity', probeIds: ['nope.probe'], configuration: { id: 'x', mode: 'headless' }
  }, dependencies), /Unknown probe id/);
  await assert.rejects(executeSuite({
    ...baseOptions, suiteId: 'nope', configuration: { id: 'x', mode: 'headless' }
  }, dependencies), /Unknown audit suite/);
  await assert.rejects(executeSuite({
    ...baseOptions, baseArgs: ['--proxy=http://u:p@h:1'], suiteId: 'wire-identity',
    configuration: { id: 'x', mode: 'headless' }
  }, dependencies), /credentialed URLs/);
  assert.equal(calls.launches, 0);
});

test('ignoreDefaultArgs and argument evidence are sanitised', () => {
  assert.deepEqual(effectiveIgnoreDefaultArgs(undefined, ['--a']), ['--a']);
  assert.deepEqual(
    effectiveIgnoreDefaultArgs(['--hide-scrollbars', '--a'], ['--a', '--blink-settings=x']),
    ['--a', '--blink-settings=x', '--hide-scrollbars']
  );
  assert.throws(() => effectiveIgnoreDefaultArgs(true), /array of "--flag" strings/);
  assert.throws(() => effectiveIgnoreDefaultArgs([true]), /array of "--flag" strings/);
  assert.throws(() => effectiveIgnoreDefaultArgs(['hide-scrollbars']), /array of "--flag" strings/);
  assert.deepEqual(
    argumentNames(['--fingerprint=1', '--proxy-server=http://u:p@h:1', 'about:blank']),
    ['--fingerprint', '--proxy-server', '[positional]']
  );
  assertSafeBaseArgs(['--fingerprint=1', 'about:blank', '--password-store=basic']);
  assert.throws(() => assertSafeBaseArgs(['--proxy=http://u:p@h:1']), /credentialed URLs/);
  assert.throws(() => assertSafeBaseArgs(['--license=abc']), /credential-like flags/);
  assert.throws(() => assertSafeBaseArgs(['--token=abc']), /credential-like flags/);
});

test('positive-control linkage only promotes an all-known-pass prior row', () => {
  assert.equal(priorVerdict({ pass: 2, fail: 0, unknown: 0 }), 'pass');
  assert.equal(priorVerdict({ pass: 2, fail: 0, unknown: 1 }), 'unknown');
  assert.equal(priorVerdict({ pass: 0, fail: 1, unknown: 0 }), 'fail');
  assert.equal(priorVerdict(null), 'unknown');
  assert.deepEqual(
    mergePriorResults(
      { 'net.h3.direct-positive-control': 'pass' },
      [
        { id: 'net.h3.direct-positive-control', counts: { pass: 0, fail: 1, unknown: 0 } },
        { id: 'net.timing.navigation-metadata', counts: { pass: 3, fail: 0, unknown: 0 } },
        { id: 'other', counts: { pass: 1, fail: 0, unknown: 2 } }
      ]
    ),
    {
      'net.h3.direct-positive-control': 'pass',
      'net.timing.navigation-metadata': 'pass',
      other: 'unknown'
    }
  );
});

test('caller ignore defaults reach the launch record', async () => {
  const { dependencies } = world();
  const result = await executeSuite({
    ...baseOptions, suiteId: 'request-paths', scenarioIds: ['rp-raw-http-anon'],
    probeIds: ['reqpath.goto.browser-stack'],
    configuration: { id: 'ign', mode: 'headless', probeConfig: { ignoreDefaultArgs: ['--hide-scrollbars'] } }
  }, dependencies);
  assert.deepEqual(result.sessions[0].launch.ignoreDefaultArgs, ['--hide-scrollbars']);
});

test('the socket witness is attached, sampled and closed before the browser server', async () => {
  const { dependencies, calls, witness } = world();
  const result = await executeSuite({ ...baseOptions, suiteId: 'wire-identity', configuration: { id: 'w', mode: 'headless' } }, dependencies);
  assert.equal(witness.state.closed, true);
  assert.deepEqual(calls.order, ['witness-close', 'browser-close']);
  assert.equal(result.sessions[0].socketWitness.absenceEstablished, false);
  assert.equal(result.sessions[0].socketWitness.coverage, 'sampled-owned-socket-metadata');
});

test('a disabled or failing witness never becomes a product failure', async () => {
  const disabled = world();
  const off = await executeSuite(
    { ...baseOptions, suiteId: 'wire-identity', configuration: { id: 'off', mode: 'headless' } },
    { ...disabled.dependencies, socketWitness: false }
  );
  assert.equal(off.aborted, false);
  assert.equal(off.sessions[0].socketWitness.reason, 'disabled-by-caller');
  const failing = world();
  const broken = await executeSuite(
    { ...baseOptions, suiteId: 'wire-identity', configuration: { id: 'broken', mode: 'headless' } },
    { ...failing.dependencies, socketWitnessFactory: () => { throw Object.assign(new Error('no proc'), { code: 'unsupported-platform' }); } }
  );
  assert.equal(broken.aborted, false);
  assert.equal(broken.sessions[0].socketWitness.reason, 'unsupported-platform');
  assert.equal(broken.sessions[0].socketWitness.absenceEstablished, false);
});

function fakeLease({ stubborn = false, limitations = [] } = {}) {
  const state = { samples: 0, terminated: [] };
  let remaining = stubborn ? [{ pid: 10, startTicks: 'a', verification: 'same-instance' }] : [];
  return {
    state,
    limitations,
    async sample() { state.samples += 1; return { identities: [{ pid: 10, startTicks: 'a' }], limitations: [] }; },
    async remaining() { return remaining; },
    async waitGone() { return remaining; },
    async terminate(name) { state.terminated.push(name); if (!stubborn) remaining = []; return [10]; }
  };
}

function fakeProfileReport(extra = {}) {
  return {
    status: 'observed',
    cleanup: {
      contextsOpened: 1, contextsClosed: 1, activeProfiles: 0, failedCleanup: false,
      processVerification: 'not-exposed-by-public-persistent-context-api', limitations: ['context-level only']
    },
    scenarios: [{ id: 'launch-contract', status: 'observed', started: 't0', finished: 't1', observations: { directory: '/tmp/private' }, checks: [{ name: 'launch/pass', passed: true }], limitations: [] }],
    ...extra
  };
}

const profileChromium = { async launchPersistentContext() { return { pages: () => [], newPage: async () => ({}), close: async () => {} }; } };

test('profile execution wraps the persistent launch in the parent child lease', async () => {
  const lease = fakeLease();
  let launches = 0;
  const chromium = {
    async launchPersistentContext() { launches += 1; return { pages: () => [], newPage: async () => ({}), close: async () => {} }; }
  };
  const result = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'], chromium,
    configuration: { id: 'profile', mode: 'headless', probeConfig: { ignoreDefaultArgs: ['--hide-scrollbars'] } }
  }, {
    childLease: async () => lease,
    runScenarios: async (options) => {
      assert.equal(options.headless, true);
      assert.deepEqual(options.baseEnv, { PATH: '/usr/bin' });
      assert.deepEqual(options.scenarios, ['launch-contract']);
      assert.deepEqual(options.contextOptions, { locale: 'en-US', timezoneId: 'UTC' });
      assert.deepEqual(options.ignoreDefaultArgs, ['--hide-scrollbars']);
      await options.chromium.launchPersistentContext('/tmp/profile');
      return fakeProfileReport({ browserVersions: ['fixture-1.0'] });
    }
  });
  assert.equal(launches, 1);
  assert.ok(lease.state.samples >= 1, 'lease sampled when the context was created');
  assert.equal(result.observations[0].status, 'observed');
  assert.equal(result.observations[0].version, 'fixture-1.0');
  assert.equal(result.observations[0].transport, 'playwright-persistent-context');
  assert.equal(result.sessions[0].processOwnership, 'parent-owned-proc-tree');
  assert.deepEqual(result.sessions[0].browserVersions, ['fixture-1.0']);
  assert.ok(result.sessions[0].launch.ignoreDefaultArgs.includes('--hide-scrollbars'));
  assert.ok(result.sessions[0].launch.persistentDriverDefaults.includes('--enable-automation'));
  assert.equal(result.cleanup.processVerification, 'verified-by-node-parent-ancestry-lease');
  assert.equal(result.cleanup.closed, true);
  assert.equal(result.aborted, false);
});

test('an unverified lease is never clean, with or without leftovers', async () => {
  const limited = fakeLease({ limitations: ['Process-tree read unavailable: EACCES'] });
  const gaps = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'],
    chromium: profileChromium, configuration: { id: 'profile', mode: 'headless' }
  }, { childLease: async () => limited, runScenarios: async () => fakeProfileReport() });
  assert.equal(gaps.cleanup.processVerification, 'unknown', 'silent /proc gaps are not verified');
  assert.equal(gaps.cleanup.closed, false);
  assert.equal(gaps.aborted, true);
  assert.deepEqual(gaps.cleanup.processTree.remaining, []);
  assert.ok(gaps.cleanup.processTree.limitations.includes('Process-tree read unavailable: EACCES'));

  const stubborn = fakeLease({ stubborn: true });
  const left = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'],
    chromium: profileChromium, configuration: { id: 'profile', mode: 'headless' }
  }, { childLease: async () => stubborn, runScenarios: async () => fakeProfileReport() });
  assert.equal(left.cleanup.processVerification, 'unknown');
  assert.equal(left.cleanup.closed, false, 'unknown process state is never reported clean');
  assert.equal(left.aborted, true);
  assert.deepEqual(stubborn.state.terminated, ['SIGTERM', 'SIGKILL']);
  assert.equal(left.sessions[0].cleanup.processVerification, 'unknown');
});

test('multiple or missing browser versions stay unknown', async () => {
  const multi = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'],
    chromium: profileChromium, configuration: { id: 'profile', mode: 'headless' }
  }, {
    childLease: async () => fakeLease(),
    runScenarios: async () => fakeProfileReport({ browserVersions: ['v1', 'v2'] })
  });
  assert.equal(multi.observations[0].version, null);
  assert.deepEqual(multi.sessions[0].browserVersions, ['v1', 'v2']);
  assert.ok(multi.cleanup.limitations.some((line) => /Multiple browser versions/.test(line)));
  const missing = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'],
    chromium: profileChromium, configuration: { id: 'profile', mode: 'headless' }
  }, { childLease: async () => fakeLease(), runScenarios: async () => fakeProfileReport() });
  assert.equal(missing.observations[0].version, null, 'no invented version when the lab reported none');
});

test('a failed profile run is reported without raw text and aborts the result', async () => {
  const result = await executeSuite({
    ...baseOptions, suiteId: 'profile-lifecycle', scenarioIds: ['launch-contract'],
    chromium: profileChromium, configuration: { id: 'profile', mode: 'headless' }
  }, {
    childLease: async () => fakeLease(),
    runScenarios: async () => { throw new Error('driver failure: target-origin-secret-value'); }
  });
  assert.equal(result.aborted, true);
  assert.equal(result.observations.length, 0);
  assert.ok(result.errors.some((entry) => entry.scope === 'profile-run'));
  assert.ok(!JSON.stringify(result).includes('target-origin-secret-value'));
});
