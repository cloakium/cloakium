// Static caller-profile integration: no BrowserServer, fixture-driven probe,
// receipt/cleanup accounting. No browser is launched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeSuite } from '../../lib/suite-execution.mjs';

const OUT = '/tmp/opencode/export-integration-out';
const CANARY = 'lab-canary-DO-NOT-USE-VALUE';

function fakeLab() {
  return {
    origin: 'http://127.0.0.1:41001',
    crossOrigin: 'http://[::1]:41001',
    close: async () => ({ closed: true, resources: 0, closedResources: 0, errors: [] })
  };
}

function fixtureReceipt(overrides = {}) {
  return {
    schema: 'cloakium.audit.profile-export-fixture/1',
    policy: 'closed-directory-copy-control-not-sdk-export',
    generated: true,
    platform: 'linux',
    mode: 'headless',
    browserVersions: ['157.0.8103.50'],
    profileCount: 4,
    portableFlag: { applied: true, name: '--fingerprint-portable-cookies' },
    canary: { name: 'lab_canary', length: 25, digest: 'a'.repeat(64), valuePersisted: false },
    seeded: { native: true, portable: true },
    restart: { canaryPresent: true, canaryValueReported: false },
    cleanup: { before: 1, after: 0, terminated: [], unknown: false },
    contextOptions: { locale: 'en-US', timezoneId: 'UTC', keys: ['locale', 'timezoneId', 'viewport'] },
    limitations: ['same-host copy control'],
    ...overrides
  };
}

async function makeFixtureInputs() {
  const root = path.join(OUT, `fixture-${process.pid}-${Date.now()}`);
  await fs.mkdir(path.join(root, 'Default'), { recursive: true, mode: 0o700 });
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(16)]);
  for (const name of ['profile-a-native', 'profile-b-portable', 'export', 'restart']) {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, 'Default'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, 'LAB_FIXTURE.json'), '{"schema":"cloakium.profile-lifecycle-fixture/1"}\n', { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'v10AAAAAAAAAAAAAAAAAAAA==' } }), { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'Default', 'Cookies'), sqlite, { mode: 0o600 });
  }
  return {
    profileDir: path.join(root, 'profile-a-native'),
    profileDirB: path.join(root, 'profile-b-portable'),
    exportDir: path.join(root, 'export'),
    restartProfileDir: path.join(root, 'restart'),
    labCanary: CANARY,
    platform: 'linux'
  };
}

function world({ receipt = fixtureReceipt(), fail = null, closeError = null, inputs = null } = {}) {
  const calls = { launches: 0, closes: 0, remove: null };
  const browserDependency = () => {
    calls.launches += 1;
    throw new Error('a BrowserServer must not be launched for caller-profile');
  };
  return {
    calls,
    dependencies: {
      launchBrowser: browserDependency,
      startLab: async () => fakeLab(),
      inspectSandbox: async () => ({ status: 'unavailable' }),
      observeEnvironment: async () => ({}),
      exportFixtureFactory: async () => {
        if (fail) throw fail;
        const resolvedInputs = inputs ?? await makeFixtureInputs();
        return {
          inputs: resolvedInputs,
          receipt,
          async close({ remove = false } = {}) {
            calls.closes += 1;
            calls.remove = remove;
            if (closeError) throw closeError;
            return receipt;
          }
        };
      }
    }
  };
}

const options = {
  suiteId: 'network',
  scenarioIds: ['caller-profile'],
  target: { executablePath: '/fixture/chromium' },
  chromium: { launchPersistentContext: async () => { throw new Error('no persistent launch expected'); } },
  configuration: { id: 'export', mode: 'headless' },
  environment: { locale: 'en-US', timezoneId: 'UTC' },
  output: OUT,
  launchEnv: { PATH: '/usr/bin' },
  baseArgs: ['--fingerprint=42424']
};

test('caller-profile runs the static probe from a fixture without BrowserServer', async () => {
  const { dependencies, calls } = world();
  const result = await executeSuite(options, dependencies);
  assert.equal(calls.launches, 0, 'no BrowserServer or persistent launch');
  assert.equal(calls.closes, 1);
  assert.equal(calls.remove, true, 'fixture is removed after the probe');
  assert.equal(result.observations.length, 1);
  const row = result.observations[0];
  assert.equal(row.id, 'profile.export.security');
  assert.ok(['observed', 'observed-with-limitations'].includes(row.status));
  assert.equal(row.transport, 'static-profile-export-fixture');
  assert.equal(row.processVerification, 'fixture-owned-lease-verified');
  assert.equal(row.version, '157.0.8103.50');
  assert.equal(row.fixture.policy, 'closed-directory-copy-control-not-sdk-export');
  assert.equal(row.fixture.canary.valuePersisted, false);
  assert.ok(!JSON.stringify(result).includes(CANARY), 'canary value is never reported');
  assert.equal(result.sessions[0].transport, 'static-profile-export-fixture');
  assert.equal(result.sessions[0].cleanup.closed, true);
  assert.equal(result.cleanup.closed, true);
  assert.equal(result.cleanup.transport, 'static-profile-export-fixture');
  assert.equal(result.cleanup.processVerification, 'fixture-owned-lease-verified');
  assert.deepEqual(result.cleanup.staticFixtures, [{ before: 1, after: 0, unknown: false, closed: true }]);
  assert.equal(result.aborted, false);
});

test('a fixture failure stops the suite without launching a browser', async () => {
  const { dependencies, calls } = world({ fail: new Error('fixture build failed: target-origin-secret') });
  const result = await executeSuite({ ...options, scenarioIds: ['caller-profile', 'default'] }, dependencies);
  assert.equal(calls.launches, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].status, 'execution-error');
  assert.ok(result.errors.some((entry) => entry.scope === 'export-fixture'));
  assert.ok(!JSON.stringify(result).includes('target-origin-secret'));
  assert.equal(result.cleanup.closed, false);
});

test('an unverified fixture cleanup is never clean and stops the suite', async () => {
  const { dependencies, calls } = world({
    receipt: fixtureReceipt({ cleanup: { before: 1, after: 1, terminated: [1], unknown: true } })
  });
  const result = await executeSuite({ ...options, scenarioIds: ['caller-profile', 'default'] }, dependencies);
  assert.equal(calls.launches, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.observations[0].processVerification, 'unknown');
  assert.equal(result.observations[0].cleanup.closed, false);
  assert.equal(result.cleanup.closed, false);
  assert.ok(result.errors.some((entry) => entry.scope === 'export-fixture'));
});

test('a fixture close error is recorded and fails closed', async () => {
  const { dependencies } = world({ closeError: new Error('close failed: target-origin-secret') });
  const result = await executeSuite(options, dependencies);
  assert.equal(result.aborted, true);
  assert.equal(result.observations[0].cleanup.closed, false);
  assert.ok(!JSON.stringify(result).includes('target-origin-secret'));
  assert.ok(result.errors.some((entry) => entry.scope === 'export-fixture'));
});
