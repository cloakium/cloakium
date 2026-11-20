// Real-stream tests for the profile-export IO layer and its probe decision rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { probes } from './profile-export.mjs';
import {
  CHUNK_BYTES,
  FIXTURE_MARKER,
  FIXTURE_OWNER,
  FIXTURE_SCHEMA,
  OVERSIZE_BYTES,
  createBudget,
  keyCandidates,
  privateRoot,
  readFixtureMarker,
  sanitizeError,
  scanDirectory,
  validateOwnedDirectory,
} from './profile-export-io.mjs';

const probe = probes[0];

async function tempRoot(label) {
  const base = await fs.mkdtemp(path.join(privateRoot(), `clad-${label}-`));
  await fs.chmod(base, 0o700);
  return base;
}

async function makeFixture(root, name, { marker = {}, mode = 0o600 } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'Default'), { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.writeFile(
    path.join(dir, FIXTURE_MARKER),
    JSON.stringify({ schema: FIXTURE_SCHEMA, owner: FIXTURE_OWNER, kind: 'test', label: name, created: new Date().toISOString(), ...marker }),
    'utf8',
  );
  await fs.chmod(path.join(dir, FIXTURE_MARKER), mode);
  return dir;
}

const byName = (output, name) => output.checks.find((check) => check.name === name) ?? null;

test('owned directory validation: containment, ancestry, mode', async () => {
  const root = await tempRoot('paths');
  try {
    const good = await makeFixture(root, 'good');
    assert.equal((await validateOwnedDirectory(good)).ok, true);
    assert.equal((await validateOwnedDirectory('relative/path')).ok, false);
    assert.equal((await validateOwnedDirectory('/etc')).ok, false);

    const loose = path.join(root, 'loose');
    await fs.mkdir(loose, { mode: 0o755 });
    await fs.chmod(loose, 0o755);
    assert.equal((await validateOwnedDirectory(loose)).ok, false);

    const link = path.join(root, 'linkdir');
    await fs.symlink(good, link);
    const viaLink = await validateOwnedDirectory(path.join(link));
    assert.equal(viaLink.ok, false);
    assert.match(viaLink.reason, /symlink/);
    assert.equal((await readFixtureMarker(path.join(link, 'Default'))).ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('marker must be ours: schema, owner, mode, regular file', async () => {
  const root = await tempRoot('marker');
  try {
    const good = await makeFixture(root, 'good');
    const read = await readFixtureMarker(good);
    assert.equal(read.ok, true);
    assert.equal(read.metadata.schema, FIXTURE_SCHEMA);
    assert.equal('body' in read.metadata, false);

    const forged = await makeFixture(root, 'forged', { marker: { schema: 'other/1' } });
    assert.equal((await readFixtureMarker(forged)).ok, false);

    const wrongOwner = await makeFixture(root, 'owner', { marker: { owner: 'someone-else' } });
    assert.equal((await readFixtureMarker(wrongOwner)).ok, false);

    const loose = await makeFixture(root, 'loose-marker', { mode: 0o644 });
    const looseRead = await readFixtureMarker(loose);
    assert.equal(looseRead.ok, false);
    assert.match(looseRead.reason, /0600/);

    const symlinked = await makeFixture(root, 'symlink-marker');
    const marker = path.join(symlinked, FIXTURE_MARKER);
    await fs.rename(marker, `${marker}.real`);
    await fs.symlink(`${marker}.real`, marker);
    assert.equal((await readFixtureMarker(symlinked)).ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('streaming scan finds a needle across a chunk boundary', async () => {
  const root = await tempRoot('boundary');
  try {
    const dir = await makeFixture(root, 'boundary');
    const needle = Buffer.from('lab-canary-boundary-marker');
    const payload = Buffer.concat([Buffer.alloc(CHUNK_BYTES - 7, 0x41), needle, Buffer.alloc(64, 0x42)]);
    await fs.writeFile(path.join(dir, 'Default', 'blob.bin'), payload);
    const scan = await scanDirectory(dir, needle, { budget: createBudget({ maxBytes: 4 * 1024 * 1024, maxMs: 5_000 }) });
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.hits, [path.join('Default', 'blob.bin')]);
    assert.equal(scan.coverage.complete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('oversized files are recorded and make coverage incomplete', async () => {
  const root = await tempRoot('oversize');
  try {
    const dir = await makeFixture(root, 'oversize');
    const big = path.join(dir, 'big.bin');
    await fs.writeFile(big, '');
    await fs.truncate(big, OVERSIZE_BYTES + 1);
    await fs.writeFile(path.join(dir, 'small.txt'), 'nothing here');
    const scan = await scanDirectory(dir, Buffer.from('absent-needle'), { budget: createBudget({ maxBytes: 1024, maxMs: 5_000 }) });
    assert.equal(scan.hits.length, 0);
    assert.equal(scan.coverage.oversize.length, 1);
    assert.equal(scan.coverage.complete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('budget exhaustion is reported instead of a silent absence', async () => {
  const root = await tempRoot('budget');
  try {
    const dir = await makeFixture(root, 'budget');
    await fs.writeFile(path.join(dir, 'a.txt'), Buffer.alloc(CHUNK_BYTES, 0x41));
    await fs.writeFile(path.join(dir, 'b.txt'), Buffer.alloc(CHUNK_BYTES, 0x42));
    const scan = await scanDirectory(dir, Buffer.from('absent-needle'), { budget: createBudget({ maxBytes: 128, maxMs: 5_000 }) });
    assert.equal(scan.coverage.budgetExceeded, true);
    assert.equal(scan.coverage.complete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('symlinks inside the tree are never followed', async () => {
  const root = await tempRoot('symlink');
  const outside = await tempRoot('outside');
  try {
    const needle = Buffer.from('outside-secret-marker');
    const secret = path.join(outside, 'secret.txt');
    await fs.writeFile(secret, needle);
    const dir = await makeFixture(root, 'with-link');
    await fs.symlink(secret, path.join(dir, 'Default', 'escape.txt'));
    const scan = await scanDirectory(dir, needle, { budget: createBudget({ maxBytes: 1024 * 1024, maxMs: 5_000 }) });
    assert.deepEqual(scan.hits, []);
    assert.equal(scan.coverage.symlinkCount, 1);
    assert.equal(scan.coverage.complete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('key-like candidates are detected by name with metadata only', async () => {
  const root = await tempRoot('keys');
  try {
    const dir = await makeFixture(root, 'keys');
    await fs.writeFile(path.join(dir, 'key'), Buffer.alloc(32, 0x5a));
    await fs.writeFile(path.join(dir, 'master_key'), Buffer.alloc(16, 0x5a));
    await fs.writeFile(path.join(dir, 'encryption.key'), Buffer.alloc(64, 0x5a));
    await fs.writeFile(path.join(dir, 'secret.json'), Buffer.alloc(20, 0x5a));
    await fs.writeFile(path.join(dir, 'unrelated.txt'), Buffer.alloc(32, 0x5a));
    const result = await keyCandidates(dir);
    assert.equal(result.ok, true);
    const names = result.candidates.map((entry) => entry.path).sort();
    assert.deepEqual(names, ['encryption.key', 'key', 'master_key', 'secret.json']);
    const byPath = Object.fromEntries(result.candidates.map((entry) => [entry.path, entry]));
    assert.equal(byPath.key.sizeClass, '32');
    assert.equal(byPath.master_key.sizeClass, '16');
    assert.equal(byPath['encryption.key'].sizeClass, 'other');
    for (const entry of result.candidates) {
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'mode', 'path', 'sizeClass']);
    }
    assert.equal(result.complete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('errors are sanitized: no message that could embed key text', () => {
  const raw = Object.assign(new Error('EBADF: key=SUPERSECRET'), { code: 'EBADF' });
  const safe = sanitizeError(raw);
  assert.deepEqual(safe, { code: 'EBADF', name: 'Error' });
  assert.equal(JSON.stringify(safe).includes('SUPERSECRET'), false);
});

test('probe: absence passes only with complete coverage', async () => {
  const root = await tempRoot('probe-absence');
  try {
    const dir = await makeFixture(root, 'clean');
    await fs.writeFile(path.join(dir, 'Default', 'Cookies'), Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(32)]));
    await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ profile: 'x' }));
    const clean = await probe.run({ profileDir: dir, labCanary: 'lab-canary-absent', canaryControl: { seeded: true }, platform: 'linux' });
    assert.equal(byName(clean, 'no-plaintext-canary-in-profile').status, 'pass');

    const dirty = await makeFixture(root, 'dirty');
    await fs.writeFile(path.join(dirty, 'leak.txt'), 'lab-canary-present');
    const leaked = await probe.run({ profileDir: dirty, labCanary: 'lab-canary-present', canaryControl: { seeded: true }, platform: 'linux' });
    assert.equal(byName(leaked, 'no-plaintext-canary-in-profile').status, 'fail');

    const undecidable = await makeFixture(root, 'big');
    const big = path.join(undecidable, 'big.bin');
    await fs.writeFile(big, '');
    await fs.truncate(big, OVERSIZE_BYTES + 1);
    const partial = await probe.run({ profileDir: undecidable, labCanary: 'lab-canary-absent', canaryControl: { seeded: true }, platform: 'linux' });
    assert.equal(byName(partial, 'no-plaintext-canary-in-profile').status, 'inconclusive');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('probe: OS-bound binding is inconclusive on Linux, evaluated on win32', async () => {
  const root = await tempRoot('probe-os');
  try {
    const dir = await makeFixture(root, 'os');
    const crypt = Buffer.concat([Buffer.from('v10'), Buffer.alloc(16, 7)]).toString('base64');
    await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: crypt } }));
    const linux = await probe.run({ profileDir: dir, platform: 'linux' });
    assert.equal(byName(linux, 'os-credential-binding').status, 'inconclusive');
    const windows = await probe.run({ profileDir: dir, platform: 'win32' });
    assert.equal(byName(windows, 'os-credential-binding').status, 'pass');
    assert.match(byName(windows, 'os-credential-binding').detail, /scheme=v10/);
    assert.equal(JSON.stringify(windows.observations).includes(crypt), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('probe: paths outside the private root are never read', async () => {
  const root = await tempRoot('probe-refuse');
  try {
    const dir = await makeFixture(root, 'ok');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'clad-outside-'));
    try {
      const forged = await probe.run({ profileDir: outside });
      assert.equal(forged.status, 'stage-needed');
      assert.equal(byName(forged, 'fixture-profile-supplied').status, 'stage-needed');

      const badExport = await probe.run({ profileDir: dir, exportDir: outside, platform: 'linux' });
      assert.equal(byName(badExport, 'export-bundle-inspected').status, 'stage-needed');
      assert.equal(byName(badExport, 'export-has-no-plaintext-canary'), null);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('broad raw-key claims never pass; the narrow candidate claim can', async () => {
  const root = await tempRoot('bound-claims');
  try {
    const dir = await makeFixture(root, 'clean');
    await fs.writeFile(path.join(dir, 'Local State'), JSON.stringify({ profile: 'x' }));
    const output = await probe.run({ profileDir: dir, labCanary: 'absent', canaryControl: { seeded: true } });
    const broad = byName(output, 'no-raw-key-blob-in-profile');
    assert.equal(broad.status, 'inconclusive');
    assert.equal(broad.passed, false);
    assert.match(broad.detail, /cannot establish absence/);
    assert.equal(byName(output, 'no-standalone-key-file-candidates-observed').status, 'pass');
    assert.equal(output.observations.rawKeyMaterialAbsence, 'unknown');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canary absence needs the seeded positive control', async () => {
  const root = await tempRoot('control');
  try {
    const dir = await makeFixture(root, 'clean');
    const without = await probe.run({ profileDir: dir, labCanary: 'absent' });
    assert.equal(byName(without, 'no-plaintext-canary-in-profile').status, 'inconclusive');
    const withControl = await probe.run({ profileDir: dir, labCanary: 'absent', canaryControl: { seeded: true } });
    assert.equal(byName(withControl, 'no-plaintext-canary-in-profile').status, 'pass');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
