// Unit tests for the pure helpers. No browser is launched.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { bounded, settle, unixSeconds } from '../lib/deadline.mjs';
import {
  assertSafeArguments, flagName, flagsPresent, hasFlag, redactArguments, withoutFlag
} from '../lib/flags.mjs';
import { createLab, IGNORED_DEFAULT_ARGS } from '../lib/lab.mjs';
import { recorder, finish } from '../lib/recorder.mjs';
import {
  assertOwnedProfile, cookieMetadata, copyOwnedProfile, inspectProfile, MARKER_FILE,
  MARKER_SCHEMA, ownedRoot, readOwnershipMarker, sha256, writeOwnershipMarker
} from '../lib/profile.mjs';
import { startLabServer } from '../lib/server.mjs';
import { baseEnvFrom, displayKeys, envKeys, launchEnv, sanitiseBaseEnv } from '../lib/env.mjs';

const ROOT = path.join(ownedRoot(), `profile-lifecycle-tests-${process.pid}`);
const MODE = /^0[0-7]{3}$/;

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

test('recorder is tri-state and refuses duplicate names', () => {
  const rec = recorder();
  rec.expect('a/pass', true);
  rec.unknown('a/gap', 'reason');
  rec.limit('code', 'detail');
  assert.deepEqual(rec.checks, [
    { name: 'a/pass', passed: true },
    { name: 'a/gap', passed: null, detail: 'reason' }
  ]);
  assert.throws(() => rec.expect('a/pass', false), /recorded twice/);
  const finished = finish(rec, { observed: 1 });
  assert.equal(finished.coverage, 'partial');
  assert.equal(finished.failed, 0);
  assert.deepEqual(finished.observations, { observed: 1 });
});

test('deadline helpers are bounded and labelled', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 15, 'never'), (error) => {
    assert.equal(error.code, 'deadline-exceeded');
    return /never: deadline 15ms/.test(error.message);
  });
  assert.equal(await bounded(Promise.resolve('ok'), 1000, 'fast'), 'ok');
  assert.deepEqual(await settle(Promise.reject(new Error('nope')), 1000, 'x'), {
    ok: false, error: 'nope', code: null
  });
  assert.equal(unixSeconds(1000), 1);
});

test('launch arguments: sandbox and credential guards', () => {
  assertSafeArguments(['--fingerprint=48213', '--fingerprint-portable-cookies']);
  assert.throws(() => assertSafeArguments(['--no-sandbox']), /sandbox-weakening/);
  assert.throws(() => assertSafeArguments(['--disable-setuid-sandbox']), /sandbox-weakening/);
  assert.throws(() => assertSafeArguments(['--disable-web-security']), /sandbox-weakening/);
  assert.throws(() => assertSafeArguments(['--proxy-server=http://user:pass@host:8080']), /credential-like/);
  assert.throws(() => assertSafeArguments([`--license=${['cb', 'abc123'].join('_')}`]), /credential-like/);
  assert.deepEqual(redactArguments(['--proxy-server=http://u:p@h:1']), ['--proxy-server=http://[REDACTED]@h:1']);
  assert.equal(flagName('--fingerprint=1'), '--fingerprint');
  assert.equal(hasFlag(['--fingerprint=1'], '--fingerprint'), true);
  assert.deepEqual(withoutFlag(['--a=1', '--b=2'], '--a'), ['--b=2']);
  assert.deepEqual(flagsPresent(['--fingerprint=1', '--x'], 'cmd --fingerprint --x'), ['--fingerprint', '--x']);
});

test('launch environment: headless never inherits a display', () => {
  const base = {
    DISPLAY: ':99', XAUTHORITY: '/tmp/xauth', WAYLAND_DISPLAY: 'wayland-0',
    HOME: '/tmp/home', PATH: '/usr/bin', NODE_OPTIONS: '--inspect'
  };
  const headless = launchEnv('headless', base);
  assert.deepEqual(envKeys(headless), ['HOME', 'PATH']);
  assert.deepEqual(displayKeys(headless), []);
  assert.equal(launchEnv(true, base).DISPLAY, undefined, 'boolean true means headless');

  const headed = launchEnv('headed', base);
  assert.deepEqual(displayKeys(headed), ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']);
  assert.deepEqual(envKeys(headed), ['DISPLAY', 'HOME', 'PATH', 'WAYLAND_DISPLAY', 'XAUTHORITY']);
  assert.throws(() => launchEnv('headed', { HOME: '/tmp/home' }), /DISPLAY/);
  assert.throws(() => launchEnv('sideways', base), /mode must be one of/);
  assert.deepEqual(sanitiseBaseEnv({ NODE_OPTIONS: '--x', DISPLAY: ':0' }), { DISPLAY: ':0' });
});

test('environment snapshot is read-only and allowlisted', () => {
  const source = { DISPLAY: ':7', PATH: '/bin', NODE_OPTIONS: '-r something' };
  const before = JSON.stringify(source);
  const base = baseEnvFrom(source);
  assert.equal(JSON.stringify(source), before, 'the source environment is not mutated');
  assert.deepEqual(Object.keys(base).sort(), ['DISPLAY', 'PATH']);
  assert.equal(base.NODE_OPTIONS, undefined);
});

test('profile markers gate every read and copy', async () => {
  const owned = path.join(ROOT, 'owned');
  await writeOwnershipMarker(owned, { label: 'unit' });
  const marker = await readOwnershipMarker(owned);
  assert.equal(marker.schema, MARKER_SCHEMA);
  assert.equal((await assertOwnedProfile(owned)).schema, MARKER_SCHEMA);

  const unowned = path.join(ROOT, 'unowned');
  await fs.mkdir(unowned, { recursive: true });
  await assert.rejects(assertOwnedProfile(unowned), /without LAB_FIXTURE/);
  await assert.rejects(assertOwnedProfile(path.join(path.parse(ROOT).root, 'not-ours')), /outside/);

  await fs.writeFile(path.join(owned, 'SingletonLock'), 'x');
  await fs.writeFile(path.join(owned, 'keep.bin'), 'y');
  const copy = path.join(ROOT, 'copy');
  await copyOwnedProfile(owned, copy);
  const entries = await fs.readdir(copy);
  assert.ok(entries.includes('keep.bin'));
  assert.ok(entries.includes(MARKER_FILE));
  assert.ok(!entries.includes('SingletonLock'));
});

test('inspection stays metadata-only and never returns key material', async () => {
  const directory = path.join(ROOT, 'inspect');
  await writeOwnershipMarker(directory, { label: 'inspect' });
  await fs.mkdir(path.join(directory, 'Default/Network'), { recursive: true });
  const canary = 'lab-dummy-canary-v1';
  const sqliteHeader = Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.from([0])]);
  await fs.writeFile(
    path.join(directory, 'Default/Network/Cookies'),
    Buffer.concat([sqliteHeader, Buffer.from('encrypted-cookie-blob-without-the-canary', 'utf8')])
  );
  const secret = 'QUJDREVGR0hJSktMTU5PUA==';
  await fs.writeFile(
    path.join(directory, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: secret, audit_enabled: false } })
  );
  await fs.writeFile(
    path.join(directory, 'Default/Preferences'),
    JSON.stringify({ default_search_provider_data: { template_url_data: { url: 'http://127.0.0.1/q' } } })
  );
  await fs.mkdir(path.join(directory, 'Default/Local Storage/leveldb'), { recursive: true });
  await fs.writeFile(path.join(directory, 'Default/Local Storage/leveldb/000003.log'), 'x');
  await fs.mkdir(path.join(directory, 'Default/IndexedDB'), { recursive: true });
  await fs.writeFile(path.join(directory, '.engine-state'), '48213');

  const profile = await inspectProfile(directory, { canary });
  assert.equal(profile.cookies.path, 'Default/Network/Cookies');
  assert.equal(profile.cookies.sqliteHeader, true);
  assert.equal(profile.cookies.canaryPlaintextFound, false);
  assert.deepEqual(profile.localState.encryptedKey, { present: true, base64Length: secret.length });
  assert.equal(profile.preferences.defaultSearchProviderDataPresent, true);
  assert.equal(profile.localStore.present, true);
  assert.equal(profile.indexedDb.present, true);
  assert.equal(profile.stateFiles.present, true);
  assert.equal(profile.stateFiles.count, 1);
  assert.equal(profile.stateFiles.files[0].bytes, 5);
  assert.match(profile.stateFiles.files[0].mode, MODE);

  const serialised = JSON.stringify(profile);
  assert.ok(!serialised.includes(secret), 'encrypted key material must never appear in the report');
  assert.ok(!serialised.includes('127.0.0.1/q'), 'provider template values must not be copied');
  assert.ok(!serialised.includes('.engine-state'), 'build-owned state file names must not be copied');
});

test('cookie metadata never carries the value', () => {
  const meta = cookieMetadata({
    name: 'lab_canary', value: 'lab-dummy-canary-v1', domain: '127.0.0.1', path: '/',
    expires: 1893456000, httpOnly: false, secure: false, sameSite: 'Lax'
  });
  assert.equal(meta.valueLength, 19);
  assert.equal(meta.valueDigest, sha256(Buffer.from('lab-dummy-canary-v1')));
  assert.ok(!JSON.stringify(meta).includes('lab-dummy-canary-v1'));
});

test('fixture server closes even with keep-alive sockets', async () => {
  const server = await startLabServer();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`${server.origin}/health`, { agent }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(body, 'ok');
    assert.equal(server.socketCount(), 1);
  } finally {
    await bounded(server.close(), 5000, 'server close');
    agent.destroy();
  }
  assert.equal(server.socketCount(), 0);
});

function fakeChromium({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async launchPersistentContext(directory, options) {
      calls.push({ directory, options });
      if (fail) throw new Error('launch boom');
      return {
        pages: () => [{ goto: async () => undefined, evaluate: async () => null }],
        close: async () => undefined,
        browser: () => ({ version: () => 'fake-1.0' })
      };
    }
  };
}

test('lab stages one persistent context at a time and keeps the sandbox on', async () => {
  const chromium = fakeChromium();
  const workRoot = path.join(ROOT, 'lab');
  const baseEnv = { DISPLAY: ':42', XAUTHORITY: '/tmp/xauth', HOME: '/tmp/home', PATH: '/usr/bin' };
  const lab = createLab({
    chromium, executablePath: '/bin/true', headless: true, baseArgs: ['--fingerprint=1'], workRoot, baseEnv
  });
  await lab.initialise();
  const first = await lab.createProfile('one');
  await lab.open({ label: 'one', directory: first });
  assert.equal(chromium.calls.length, 1);
  assert.equal(chromium.calls[0].options.chromiumSandbox, true);
  assert.deepEqual(chromium.calls[0].options.ignoreDefaultArgs, IGNORED_DEFAULT_ARGS);
  assert.ok(!chromium.calls[0].options.args.includes('--no-sandbox'));
  assert.equal(chromium.calls[0].options.env.DISPLAY, undefined, 'headless launch must not inherit DISPLAY');
  assert.equal(chromium.calls[0].options.env.XAUTHORITY, undefined);
  assert.deepEqual(displayKeys(chromium.calls[0].options.env), []);
  await assert.rejects(lab.open({ label: 'two', directory: first }), /still open/);
  await lab.close();
  await lab.open({ label: 'one-again', directory: first, args: ['--fingerprint-portable-cookies'] });
  await lab.close();
  assert.equal(chromium.calls.length, 2);
  await assert.rejects(
    lab.open({ label: 'bad', directory: first, args: ['--no-sandbox'] }),
    /sandbox-weakening/
  );
  await lab.dispose();
  assert.equal(await fs.stat(first).catch(() => null), null);
});

test('lab merges caller ignore defaults and passes locale/timezone to the persistent launch', async () => {
  const chromium = fakeChromium();
  const workRoot = path.join(ROOT, 'lab-context');
  const lab = createLab({
    chromium, executablePath: '/bin/true', headless: true, baseArgs: [], workRoot,
    ignoreDefaultArgs: ['--hide-scrollbars', '--enable-automation'],
    contextOptions: { locale: 'en-US', timezoneId: 'UTC' }
  });
  await lab.initialise();
  const directory = await lab.createProfile('context');
  await lab.open({ label: 'context', directory });
  const options = chromium.calls[0].options;
  assert.deepEqual(options.ignoreDefaultArgs, [...IGNORED_DEFAULT_ARGS, '--hide-scrollbars']);
  assert.equal(options.locale, 'en-US');
  assert.equal(options.timezoneId, 'UTC');
  assert.equal(options.viewport, null);
  assert.deepEqual(lab.ignoreDefaultArgs, options.ignoreDefaultArgs);
  await lab.close();
  await lab.open({ label: 'context-2', directory, contextOptions: { locale: 'de-DE' } });
  assert.equal(chromium.calls[1].options.locale, 'de-DE');
  assert.equal(chromium.calls[1].options.timezoneId, 'UTC');
  await lab.close();
  await assert.rejects(lab.open({ label: 'bad', directory, contextOptions: [] }), /contextOptions must be an object/);
  assert.throws(() => createLab({
    chromium, executablePath: '/bin/true', headless: true, baseArgs: [], workRoot,
    ignoreDefaultArgs: ['hide-scrollbars']
  }), /ignoreDefaultArgs must be an array of "--flag" strings/);
  await lab.dispose();
});

test('lab refuses to launch when a previous close failed', async () => {
  const chromium = fakeChromium();
  const workRoot = path.join(ROOT, 'lab-fail');
  const lab = createLab({ chromium, executablePath: '/bin/true', headless: true, baseArgs: [], workRoot });
  await lab.initialise();
  const directory = await lab.createProfile('broken');
  const opened = await lab.open({ label: 'broken', directory });
  opened.context.close = async () => { throw new Error('fixture close failure: close boom'); };
  await assert.rejects(lab.close(), /context close failed/);
  const stats = lab.stats();
  assert.equal(stats.contextsOpened, 1);
  assert.equal(stats.contextsClosed, 0);
  assert.equal(stats.closeFailures, 1);
  assert.equal(stats.failedCleanup, true);
  assert.equal(stats.activeContexts, 0);
  await assert.rejects(lab.open({ label: 'next', directory }), /previous close failed/);
  await lab.dispose();
});

test('a categorised close failure never retains the driver message', async () => {
  const chromium = fakeChromium();
  const workRoot = path.join(ROOT, 'lab-secret');
  const lab = createLab({ chromium, executablePath: '/bin/true', headless: true, baseArgs: [], workRoot });
  await lab.initialise();
  const directory = await lab.createProfile('secret');
  const opened = await lab.open({ label: 'secret', directory });
  opened.context.close = async () => { throw new Error('license key: driver-secret-value'); };
  const error = await lab.close().then(() => null, (caught) => caught);
  assert.ok(error, 'close must fail');
  assert.equal(error.message, 'context close failed');
  assert.equal(error.auditError.category, 'operation-failed');
  const serialised = JSON.stringify(lab.launches);
  assert.ok(!serialised.includes('driver-secret-value'), 'launch records keep no driver text');
  await lab.dispose();
});
