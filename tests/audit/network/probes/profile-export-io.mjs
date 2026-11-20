// Bounded, symlink-safe inspection of lab-owned profile fixtures.
//
// Every read is: realpath-contained in the private root, no symlink anywhere in
// the path or the tree, marker-verified, size/budget-bounded, and metadata-only
// for anything that could carry key material. Nothing here returns a key value,
// a raw JSON body or an unsanitised error message.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MARKER_FILE, MARKER_SCHEMA } from '../../profile-lifecycle/lib/profile.mjs';

export const FIXTURE_MARKER = MARKER_FILE;
export const FIXTURE_SCHEMA = MARKER_SCHEMA;
export const FIXTURE_OWNER = 'profile-lifecycle';

export const CHUNK_BYTES = 64 * 1024;
export const OVERSIZE_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 400;
export const MAX_MARKER_BYTES = 4096;

// Candidate *names* only: generic key-like shapes, never a vendor filename.
// This is a naming heuristic, not evidence that a file holds key material.
export const KEY_LIKE = /(^|[._-])(key|secret|master|encryption)([._-]|$)/i;

export function isKeyCandidateName(name) {
  return KEY_LIKE.test(name);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Never surface a raw error message: it can embed file content. */
export function sanitizeError(error) {
  return { code: String(error?.code ?? 'error'), name: String(error?.name ?? 'Error') };
}

export function privateRoot() {
  return process.env.CLOAKIUM_AUDIT_PRIVATE_ROOT || '/tmp/opencode';
}

function octal(mode) {
  return `0${(mode & 0o777).toString(8)}`;
}

function isOurs(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

/**
 * Absolute, inside the private root, every component a real directory, private
 * mode, owned by this uid. Symlinked ancestors and `..` are refused.
 */
export async function validateOwnedDirectory(directory, { root = privateRoot(), label = 'directory' } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    return { ok: false, reason: `${label} must be an absolute path` };
  }
  const rootReal = await fs.realpath(root).catch(() => null);
  if (!rootReal) return { ok: false, reason: 'private root is not readable' };
  const resolved = path.resolve(directory);
  if (!`${resolved}${path.sep}`.startsWith(`${rootReal}${path.sep}`)) {
    return { ok: false, reason: `${label} is outside the private root` };
  }
  let current = rootReal;
  for (const part of path.relative(rootReal, resolved).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return { ok: false, reason: `${label} does not exist` };
    if (stat.isSymbolicLink()) return { ok: false, reason: `${label} has a symlinked component` };
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) return { ok: false, reason: `${label} is not a directory` };
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, reason: `${label} is not private (mode ${octal(stat.mode)})` };
  }
  if (!isOurs(stat)) return { ok: false, reason: `${label} is not owned by this uid` };
  return { ok: true, resolved };
}

/**
 * Marker must be a regular 0600 file owned by us, of the producer's exact schema
 * and owner. Returns metadata only: never the JSON body.
 */
export async function readFixtureMarker(directory, { root = privateRoot() } = {}) {
  const container = await validateOwnedDirectory(directory, { root, label: 'fixture directory' });
  if (!container.ok) return { ok: false, reason: container.reason };
  const markerPath = path.join(container.resolved, FIXTURE_MARKER);
  const stat = await fs.lstat(markerPath).catch(() => null);
  if (!stat) return { ok: false, reason: `${FIXTURE_MARKER} is missing` };
  if (stat.isSymbolicLink()) return { ok: false, reason: `${FIXTURE_MARKER} is a symlink` };
  if (!stat.isFile()) return { ok: false, reason: `${FIXTURE_MARKER} is not a regular file` };
  if ((stat.mode & 0o777) !== 0o600) {
    return { ok: false, reason: `${FIXTURE_MARKER} mode is ${octal(stat.mode)}, expected 0600` };
  }
  if (!isOurs(stat)) return { ok: false, reason: `${FIXTURE_MARKER} is not owned by this uid` };
  if (stat.size > MAX_MARKER_BYTES) return { ok: false, reason: `${FIXTURE_MARKER} is oversized` };
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch {
    return { ok: false, reason: `${FIXTURE_MARKER} is not valid JSON` };
  }
  if (parsed?.schema !== FIXTURE_SCHEMA || parsed?.owner !== FIXTURE_OWNER) {
    return { ok: false, reason: `${FIXTURE_MARKER} is not this lab's fixture marker` };
  }
  return {
    ok: true,
    metadata: {
      schema: FIXTURE_SCHEMA,
      owner: FIXTURE_OWNER,
      kind: typeof parsed.kind === 'string' ? parsed.kind : null,
      label: typeof parsed.label === 'string' ? parsed.label : null,
      created: typeof parsed.created === 'string' ? parsed.created : null,
      bytes: stat.size,
      mode: octal(stat.mode),
    },
  };
}

async function walkFiles(directory) {
  const files = [];
  const symlinks = [];
  const queue = [''];
  while (queue.length && files.length < MAX_FILES) {
    const relative = queue.shift();
    const absolute = path.join(directory, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name);
      const childAbsolute = path.join(directory, childRelative);
      const stat = await fs.lstat(childAbsolute).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        symlinks.push(childRelative);
        continue;
      }
      if (stat.isDirectory()) queue.push(childRelative);
      else if (stat.isFile()) files.push({ relative: childRelative, absolute: childAbsolute, size: stat.size });
      if (files.length >= MAX_FILES) break;
    }
  }
  return { files, symlinks, truncated: files.length >= MAX_FILES };
}

/** Streams a file in fixed chunks; the carry keeps a boundary-spanning needle. */
async function fileContains(file, needle, budget) {
  const handle = await fs.open(file, 'r');
  try {
    let carry = Buffer.alloc(0);
    let bytes = 0;
    for (;;) {
      if (budget.exhausted()) return { found: false, bytes, status: 'budget' };
      const buffer = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return { found: false, bytes, status: 'ok' };
      bytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const window = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      if (window.includes(needle)) return { found: true, bytes, status: 'ok' };
      const keep = Math.max(0, Math.min(window.length, needle.length - 1));
      carry = Buffer.from(window.subarray(window.length - keep));
    }
  } finally {
    await handle.close();
  }
}

export function createBudget({ maxBytes = 256 * 1024 * 1024, maxMs = 20_000 } = {}) {
  const started = Date.now();
  let bytes = 0;
  return {
    add(count) {
      bytes += count;
    },
    get bytes() {
      return bytes;
    },
    exhausted() {
      return bytes >= maxBytes || Date.now() - started >= maxMs;
    },
  };
}

/**
 * Scan a fixture for a plaintext needle with explicit coverage accounting.
 * `complete` is true only when every file was fully read, none were skipped and
 * no budget was exhausted.
 */
export async function scanDirectory(directory, needle, { root = privateRoot(), budget = createBudget() } = {}) {
  const container = await validateOwnedDirectory(directory, { root, label: 'scan directory' });
  if (!container.ok) return { ok: false, reason: container.reason };
  const { files, symlinks, truncated } = await walkFiles(container.resolved);
  const coverage = {
    fileCount: files.length,
    filesScanned: 0,
    bytesRead: 0,
    readErrors: 0,
    oversize: [],
    symlinks: symlinks.slice(0, 32),
    symlinkCount: symlinks.length,
    truncated,
    budgetExceeded: false,
  };
  const hits = [];
  for (const file of files) {
    if (file.size > OVERSIZE_BYTES) {
      coverage.oversize.push({ path: file.relative, bytes: file.size });
      continue;
    }
    let outcome;
    try {
      outcome = await fileContains(file.absolute, needle, budget);
    } catch (error) {
      coverage.readErrors += 1;
      void sanitizeError(error);
      continue;
    }
    coverage.filesScanned += 1;
    coverage.bytesRead += outcome.bytes;
    budget.add(outcome.bytes);
    if (outcome.status === 'budget') {
      coverage.budgetExceeded = true;
      break;
    }
    if (outcome.found) hits.push(file.relative);
  }
  coverage.complete =
    !coverage.truncated &&
    !coverage.budgetExceeded &&
    coverage.readErrors === 0 &&
    coverage.oversize.length === 0 &&
    coverage.symlinkCount === 0 &&
    coverage.filesScanned === coverage.fileCount;
  return { ok: true, hits, coverage };
}

/** Key-shaped files by name and metadata only; the bytes are never read. */
/**
 * Key-like file *candidates* by generic name pattern and metadata only.
 * Presence is not proof of key function and absence is not proof that no key
 * material exists elsewhere (embedded, encoded, or under another name).
 */
export async function keyCandidates(directory, { root = privateRoot() } = {}) {
  const container = await validateOwnedDirectory(directory, { root, label: 'key scan directory' });
  if (!container.ok) return { ok: false, reason: container.reason };
  const { files, symlinks, truncated } = await walkFiles(container.resolved);
  const candidates = [];
  for (const file of files) {
    const name = path.basename(file.relative);
    if (!isKeyCandidateName(name)) continue;
    const stat = await fs.lstat(file.absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    candidates.push({
      path: file.relative,
      bytes: file.size,
      mode: octal(stat.mode),
      sizeClass: file.size === 16 || file.size === 32 ? String(file.size) : 'other',
    });
  }
  return {
    ok: true,
    candidates,
    symlinkCount: symlinks.length,
    truncated,
    complete: !truncated && symlinks.length === 0,
  };
}

export function schemeOf(base64Value) {
  if (typeof base64Value !== 'string' || !base64Value) return null;
  try {
    const head = Buffer.from(base64Value, 'base64').subarray(0, 3).toString('latin1');
    return head === 'v10' || head === 'v11' ? head : 'other';
  } catch {
    return 'unknown';
  }
}

/** Local State metadata: names, scheme and a digest used only for comparisons. */
export async function localStateMetadata(directory, { root = privateRoot() } = {}) {
  const container = await validateOwnedDirectory(directory, { root, label: 'local state directory' });
  if (!container.ok) return { ok: false, reason: container.reason };
  const target = path.join(container.resolved, 'Local State');
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return { ok: true, present: false };
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'Local State is not a regular file' };
  if (stat.size > OVERSIZE_BYTES) return { ok: false, reason: 'Local State is oversized' };
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return { ok: true, present: true, parsable: false, osCryptPresent: false, keyNames: [], scheme: null, identifierDigest: null };
  }
  const osCrypt = parsed?.os_crypt ?? null;
  const value = osCrypt?.encrypted_key;
  return {
    ok: true,
    present: true,
    parsable: true,
    osCryptPresent: Boolean(osCrypt),
    keyNames: osCrypt && typeof osCrypt === 'object' ? Object.keys(osCrypt).sort() : [],
    scheme: typeof value === 'string' ? schemeOf(value) : null,
    keyLength: typeof value === 'string' ? value.length : 0,
    identifierDigest: typeof value === 'string' ? sha256(Buffer.from(value)) : null,
  };
}

export function sameIdentifier(left, right) {
  if (!left?.identifierDigest || !right?.identifierDigest) return null;
  return left.identifierDigest === right.identifierDigest;
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'utf8');

/** Presence and 16-byte header only for the known store files. */
export async function storeMetadata(directory, { root = privateRoot() } = {}) {
  const container = await validateOwnedDirectory(directory, { root, label: 'store directory' });
  if (!container.ok) return { ok: false, reason: container.reason };
  const candidates = ['Default/Network/Cookies', 'Default/Cookies', 'Default/Login Data', 'Default/Web Data'];
  const stores = [];
  for (const relative of candidates) {
    const target = path.join(container.resolved, relative);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile()) continue;
    const handle = await fs.open(target, 'r');
    let sqlite = false;
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, 0);
      sqlite = bytesRead === 16 && header.equals(SQLITE_MAGIC);
    } finally {
      await handle.close();
    }
    stores.push({ path: relative, bytes: stat.size, sqliteHeader: sqlite });
  }
  return { ok: true, stores };
}
