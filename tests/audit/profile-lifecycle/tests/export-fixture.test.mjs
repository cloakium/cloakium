// Fixture API tests with an injected fake browser and lease (no real browser).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  POLICY,
  PORTABLE_FLAG,
  createProfileExportFixture,
} from '../lib/export-fixture.mjs';
import { readOwnershipMarker, ownedRoot } from '../lib/profile.mjs';

async function tempOutput(label) {
  const dir = await fs.mkdtemp(path.join(ownedRoot(), `clad-${label}-`));
  await fs.chmod(dir, 0o700);
  return dir;
}

function fakeChromium(record) {
  return {
    async launchPersistentContext(directory, options) {
      record.push({ directory, options: JSON.parse(JSON.stringify({ ...options, env: Object.keys(options.env ?? {}) })) });
      const page = { async goto() { return null; } };
      return {
        pages: () => [page],
        newPage: async () => page,
        browser: () => ({ version: () => '157.0.8103.50' }),
        async addCookies(cookies) {
          record.push({ addedCookies: cookies.length });
        },
        async cookies() {
          return [{ name: 'lab_canary', value: 'not-a-real-value' }];
        },
        async close() {
          record.push({ closed: true });
        },
      };
    },
  };
}

const NO_SANDBOX_ARG = ['--no', 'sandbox'].join('-');

const quietLease = () => ({
  async sample() {
    return { identities: [], limitations: [] };
  },
  async remaining() {
    return [];
  },
  async terminate() {
    return [];
  },
  async waitGone() {
    return [];
  },
});

test('builds four marked profiles and never persists the canary value', async () => {
  const output = await tempOutput('fx');
  const record = [];
  const fixture = await createProfileExportFixture({
    chromium: fakeChromium(record),
    target: { executablePath: '/bin/true' },
    configuration: { mode: 'headless', probeConfig: {} },
    environment: { locale: 'en-GB', timezoneId: 'UTC' },
    output,
    launchEnv: {},
    baseArgs: [],
    dependencies: { createLease: quietLease },
  });
  try {
    const { inputs, receipt } = fixture;
    for (const key of ['profileDir', 'profileDirB', 'exportDir', 'restartProfileDir']) {
      assert.equal(path.isAbsolute(inputs[key]), true, `${key} is absolute`);
      const marker = await readOwnershipMarker(inputs[key]);
      assert.ok(marker, `${key} carries a lab marker`);
    }
    assert.equal(receipt.policy, POLICY);
    assert.equal(receipt.profileCount, 4);
    assert.equal(receipt.generated, true);
    assert.equal(receipt.portableFlag.applied, true);
    assert.equal(receipt.canary.valuePersisted, false);
    assert.equal(receipt.seeded.native && receipt.seeded.portable, true, 'seed positive control');
    assert.deepEqual(inputs.canaryControl, { seeded: true });
    assert.equal(JSON.stringify(receipt).includes(inputs.labCanary), false, 'receipt never carries the canary value');
    assert.deepEqual(receipt.cleanup, { before: 0, after: 0, terminated: [], unknown: false });

    const launches = record.filter((entry) => entry.options);
    assert.equal(launches.length >= 3, true, "native seed, portable seed and restart read");
    for (const entry of launches) {
      assert.equal(entry.options.chromiumSandbox, true);
      assert.equal(entry.options.args.includes(NO_SANDBOX_ARG), false, 'sandbox stays enabled');
      assert.equal(entry.options.headless, true);
      assert.equal(entry.options.locale, 'en-GB', 'locale is spread onto the launch');
      assert.equal(entry.options.timezoneId, 'UTC');
    }
    const portableLegs = launches.filter((entry) => entry.options.args.includes(PORTABLE_FLAG));
    assert.equal(portableLegs.length >= 1, true, 'the portable leg carries the documented switch');
  } finally {
    await fixture.close({ remove: true });
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('close({remove:true}) removes only marked directories', async () => {
  const output = await tempOutput('fx-rm');
  const record = [];
  const fixture = await createProfileExportFixture({
    chromium: fakeChromium(record),
    target: { executablePath: '/bin/true' },
    configuration: { mode: 'headless' },
    environment: {},
    output,
    launchEnv: {},
    baseArgs: [],
    dependencies: { createLease: quietLease },
  });
  const { inputs } = fixture;
  const foreign = path.join(output, 'export-fixture', 'not-ours');
  await fs.mkdir(foreign, { recursive: true, mode: 0o700 });
  await fixture.close({ remove: true });
  for (const key of ['profileDir', 'profileDirB', 'exportDir', 'restartProfileDir']) {
    await assert.rejects(fs.stat(inputs[key]), `${key} removed`);
  }
  assert.ok(await fs.stat(foreign), 'an unmarked directory is left alone');
  await fs.rm(output, { recursive: true, force: true });
});

test('refuses a C locale and license arguments', async () => {
  const output = await tempOutput('fx-bad');
  try {
    await assert.rejects(
      createProfileExportFixture({
        chromium: fakeChromium([]),
        target: { executablePath: '/bin/true' },
        configuration: { mode: 'headless' },
        environment: { locale: 'C.UTF-8' },
        output,
        launchEnv: {},
        baseArgs: [],
      }),
      /C\/POSIX locale/,
    );
    await assert.rejects(
      createProfileExportFixture({
        chromium: fakeChromium([]),
        target: { executablePath: '/bin/true' },
        configuration: { mode: 'headless' },
        environment: {},
        output,
        launchEnv: {},
        baseArgs: ['--license-key=not-allowed'],
      }),
      /license/,
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('unclean descendant cleanup fails closed with a receipt', async () => {
  const output = await tempOutput('fx-leak');
  const lingeringLease = () => ({
    async sample() {
      return { identities: [{ pid: 999999, startTicks: 1 }], limitations: [] };
    },
    async remaining() {
      return [{ pid: 999999, startTicks: 1 }];
    },
    async terminate() {
      return [];
    },
    async waitGone() {
      return [];
    },
  });
  try {
    await assert.rejects(
      createProfileExportFixture({
        chromium: fakeChromium([]),
        target: { executablePath: '/bin/true' },
        configuration: { mode: 'headless' },
        environment: {},
        output,
        launchEnv: {},
        baseArgs: [],
        dependencies: { createLease: lingeringLease },
      }),
      (error) => {
        assert.equal(error.code, 'fixture-cleanup-unknown');
        assert.equal(error.receipt.cleanup.unknown, true);
        assert.equal(error.receipt.policy, POLICY);
        return true;
      },
    );
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
