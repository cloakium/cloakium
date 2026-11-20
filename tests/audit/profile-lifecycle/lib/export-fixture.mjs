// Closed-profile export fixture for the static profile-export probe.
//
// It builds four lab-owned profiles (native A, portable B, a copy of B used as
// the "export" bundle, and a copy of that copy used for the restart read) using
// the existing persistent-context lab, then hands their paths to the probe.
// This is a same-host directory-copy control, not a vendor SDK export and not a
// cross-machine portability proof.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CANARY } from './canary.mjs';
import { hasFlag } from './flags.mjs';
import { createLab } from './lab.mjs';
import {
  copyOwnedProfile,
  isInsideOwnedRoot,
  readOwnershipMarker,
  sha256,
  ownedRoot,
} from './profile.mjs';
import { startLabServer } from './server.mjs';
import { createChildLease } from '../../lib/processes.mjs';

export const PORTABLE_FLAG = '--fingerprint-portable-cookies';
export const FIXTURE_SCHEMA = 'cloakium.audit.profile-export-fixture/1';
export const POLICY = 'closed-directory-copy-control-not-sdk-export';
export const STAGE_BUDGET_MS = 180_000;

const LICENSE_ARG = /(^|[-_/])licen[cs]e/i;

function assert(condition, message) {
  if (!condition) throw new Error(`createProfileExportFixture: ${message}`);
}

/** Locale must be a real browser locale; the C/POSIX locales are not. */
export function assertBrowserLocale(locale) {
  if (locale == null) return;
  assert(typeof locale === 'string' && locale.length > 0, 'environment.locale must be a non-empty string');
  assert(!/^C(\.|$)/.test(locale), 'environment.locale must not be a C/POSIX locale');
  assert(!/utf-?8$/i.test(locale) || !/^C$/i.test(locale.split('.')[0]), 'environment.locale must be a real locale');
}

export function assertNoLicenseArgs(baseArgs) {
  assert(Array.isArray(baseArgs), 'baseArgs must be an array');
  for (const arg of baseArgs) {
    assert(typeof arg === 'string', 'baseArgs entries must be strings');
    assert(!LICENSE_ARG.test(arg), 'baseArgs must not carry a license flag');
  }
}

export async function createProfileExportFixture({
  chromium,
  target: { executablePath } = {},
  configuration: { mode = 'headless', contextOptions = {}, probeConfig = {} } = {},
  environment: { locale = null, timezoneId = null } = {},
  output,
  launchEnv = {},
  baseArgs = [],
  signal = null,
  dependencies = {},
} = {}) {
  assert(chromium && typeof chromium.launchPersistentContext === 'function', 'chromium BrowserType is required');
  assert(typeof executablePath === 'string' && path.isAbsolute(executablePath), 'target.executablePath must be absolute');
  assert(mode === 'headless' || mode === 'headed', "configuration.mode must be 'headless' or 'headed'");
  assert(typeof output === 'string' && path.isAbsolute(output), 'output must be an absolute path');
  assert(isInsideOwnedRoot(output), `output must live under ${ownedRoot()}`);
  assertNoLicenseArgs(baseArgs);
  assertBrowserLocale(locale);
  if (mode === 'headed') assert(typeof launchEnv?.DISPLAY === 'string' && launchEnv.DISPLAY.startsWith(':'), 'headed mode needs an owned DISPLAY in launchEnv');
  if (signal?.aborted) throw new Error('createProfileExportFixture: aborted before start');

  const deadline = Date.now() + STAGE_BUDGET_MS;
  const budget = () => {
    const left = deadline - Date.now();
    if (left <= 1_000) throw new Error('createProfileExportFixture: 180s stage budget exhausted');
    return left;
  };

  const root = path.join(output, 'export-fixture');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const profileDir = path.join(root, 'profile-a-native');
  const profileDirB = path.join(root, 'profile-b-portable');
  const exportDir = path.join(root, 'export');
  const restartProfileDir = path.join(root, 'restart');

  // Random per run; only the name, length and digest ever leave this function.
  const canaryValue = `lab-run-${randomBytes(16).toString('hex')}`;
  const canary = {
    name: CANARY.cookieName,
    length: canaryValue.length,
    digest: sha256(Buffer.from(canaryValue)),
    valuePersisted: false,
  };

  const portableApplied = !hasFlag(baseArgs, PORTABLE_FLAG);
  const portableArgs = portableApplied ? [...baseArgs, PORTABLE_FLAG] : [...baseArgs];
  const context = {
    viewport: null,
    ...(locale ? { locale } : {}),
    ...(timezoneId ? { timezoneId } : {}),
    ...(contextOptions ?? {}),
  };

  const server = await startLabServer();
  const leaseFactory = dependencies.createLease ?? createChildLease;
  const lease = await leaseFactory(process.pid);
  const before = await lease.sample();
  const cleanup = { before: before.identities.length, after: null, terminated: [], unknown: false };
  const launches = [];

  let lab = null;
  let closed = false;
  let receipt = null;
  const seeded = { native: false, portable: false };

  const seedOrRead = async (label, directory, args, { write }) => {
    const opened = await lab.open({ label, directory, args });
    launches.push({ label, version: opened.entry?.version ?? null });
    try {
      await opened.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: Math.min(10_000, budget()) });
      if (write) {
        await opened.context.addCookies([
          {
            name: CANARY.cookieName,
            value: canaryValue,
            domain: new URL(server.origin).hostname,
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 3600,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax',
          },
        ]);
      }
      const cookies = await opened.context.cookies(server.origin);
      return cookies.some((cookie) => cookie.name === CANARY.cookieName);
    } finally {
      await lab.close();
    }
  };

  try {
    lab = createLab({
      chromium,
      executablePath,
      headless: mode !== 'headed',
      baseArgs: portableArgs,
      workRoot: root,
      baseEnv: launchEnv,
      ignoreDefaultArgs: probeConfig?.ignoreDefaultArgs ?? [],
      contextOptions: context,
      keepProfiles: true,
      launchTimeoutMs: Math.min(60_000, budget()),
    });
    await lab.initialise();
    await lab.createProfile('profile-a-native', { kind: 'export-fixture-native' });
    await lab.createProfile('profile-b-portable', { kind: 'export-fixture-portable' });

    seeded.native = await seedOrRead("profile-a-native-write", profileDir, baseArgs, { write: true });
    seeded.portable = await seedOrRead("profile-b-portable-write", profileDirB, portableArgs, { write: true });
    if (!seeded.native || !seeded.portable) {
      const error = new Error("createProfileExportFixture: canary cookie was not seeded in every profile");
      error.code = "fixture-seed-control-failed";
      throw error;
    }

    await lab.closeAll();
    await copyOwnedProfile(profileDirB, exportDir);
    await copyOwnedProfile(exportDir, restartProfileDir);
    const restartCanaryPresent = await seedOrRead('restart-read', restartProfileDir, portableArgs, { write: false });

    await lab.closeAll();
    await lab.dispose().catch(() => {});

    const lingering = await lease.remaining();
    if (lingering.length) {
      cleanup.terminated = lingering.map((row) => row.pid);
      await lease.terminate('SIGTERM');
      await lease.waitGone(5_000);
    }
    const after = await lease.remaining();
    cleanup.after = after.length;
    cleanup.unknown = after.length > 0;

    receipt = {
      schema: FIXTURE_SCHEMA,
      policy: POLICY,
      generated: true,
      platform: process.platform,
      mode,
      browserVersions: [...new Set(launches.map((entry) => entry.version).filter(Boolean))],
      profileCount: 4,
      portableFlag: { applied: portableApplied, name: PORTABLE_FLAG },
      canary,
      seeded: { ...seeded },
      restart: { canaryPresent: restartCanaryPresent, canaryValueReported: false },
      cleanup,
      contextOptions: { locale, timezoneId, keys: Object.keys(context).sort() },
      limitations: [
        'Same-host directory copy of a closed profile: this is not a vendor SDK export and does not prove cross-machine portability.',
        'The portable flag is applied to the portable leg only; a target that ignores or records the argument is reported as such, never described as honouring it.',
        'The canary value is never persisted: only its name, length and digest appear in the receipt.',
      ],
    };
    if (cleanup.unknown) {
      const error = new Error('createProfileExportFixture: owned descendants survived cleanup');
      error.code = 'fixture-cleanup-unknown';
      error.receipt = receipt;
      throw error;
    }
    if (signal?.aborted) throw new Error('createProfileExportFixture: aborted');
  } catch (error) {
    await lab?.closeAll?.().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }

  const inputs = {
    profileDir,
    profileDirB,
    exportDir,
    restartProfileDir,
    labCanary: canaryValue,
    canaryControl: { seeded: seeded.native && seeded.portable },
    platform: process.platform,
  };

  async function close({ remove = false } = {}) {
    if (closed) return receipt;
    closed = true;
    await lab?.closeAll?.().catch(() => {});
    await server.close().catch(() => {});
    if (remove) {
      for (const directory of [profileDir, profileDirB, exportDir, restartProfileDir]) {
        const marker = await readOwnershipMarker(directory).catch(() => null);
        if (marker) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
    return receipt;
  }

  return { inputs, receipt, close };
}
