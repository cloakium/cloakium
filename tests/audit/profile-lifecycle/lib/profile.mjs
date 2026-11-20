// Profile ownership, safe copying, and metadata-only inspection.
//
// The lab only touches profiles it created: each carries LAB_FIXTURE.json and
// lives under one private root. Inspection reads metadata and key names only.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MARKER_FILE = 'LAB_FIXTURE.json';
export const MARKER_SCHEMA = 'cloakium.profile-lifecycle-fixture/1';

// Lab state lives under one private root: CLOAKIUM_AUDIT_PRIVATE_ROOT when the
// caller sets it, otherwise the pre-created agent temp root.
export function ownedRoot() {
  const root = process.env.CLOAKIUM_AUDIT_PRIVATE_ROOT || '/tmp/opencode';
  return root.endsWith(path.sep) ? root : `${root}${path.sep}`;
}

const SKIP_COPY = new Set([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'DevToolsActivePort'
]);

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function isInsideOwnedRoot(target) {
  const resolved = path.resolve(target);
  return (resolved + path.sep).startsWith(ownedRoot());
}

export async function writeOwnershipMarker(directory, meta = {}) {
  const marker = {
    schema: MARKER_SCHEMA,
    owner: 'profile-lifecycle',
    created: new Date().toISOString(),
    ...meta
  };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return marker;
}

export async function readOwnershipMarker(directory) {
  try {
    const text = await fs.readFile(path.join(directory, MARKER_FILE), 'utf8');
    const marker = JSON.parse(text);
    return marker?.schema === MARKER_SCHEMA ? marker : null;
  } catch {
    return null;
  }
}

// Refuses to copy or inspect anything that is not a lab-owned profile.
export async function assertOwnedProfile(directory) {
  const resolved = path.resolve(directory);
  if (!isInsideOwnedRoot(resolved)) {
    throw new Error(`refusing to touch a profile outside ${ownedRoot()}: ${resolved}`);
  }
  const marker = await readOwnershipMarker(resolved);
  if (!marker) throw new Error(`refusing to touch a profile without ${MARKER_FILE}: ${resolved}`);
  return marker;
}

export async function createProfileDirectory(root, label, meta = {}) {
  const directory = path.join(root, label);
  await writeOwnershipMarker(directory, { label, ...meta });
  return directory;
}

// Copies a closed, lab-owned profile. Singleton locks and devtools port files are
// skipped so the copy can start cleanly.
export async function copyOwnedProfile(source, destination) {
  await assertOwnedProfile(source);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (entry) => !SKIP_COPY.has(path.basename(entry))
  });
  await assertOwnedProfile(destination);
  const entries = await fs.readdir(destination);
  return { destination, entries: entries.length };
}

async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

async function treeMetadata(directory, limit = 300) {
  const rows = [];
  let truncated = false;
  const queue = [''];
  while (queue.length) {
    const relative = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Root-level dotfiles are reported generically by topLevelStateFiles(); their
      // build-chosen names are not copied into the observation.
      if (!relative && entry.name.startsWith('.')) continue;
      if (rows.length >= limit) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const child = path.join(relative, entry.name);
      const stat = await statOrNull(path.join(directory, child));
      if (!stat) continue;
      rows.push({
        path: child,
        kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'link',
        bytes: stat.isFile() ? stat.size : null,
        mode: `0${(stat.mode & 0o777).toString(8)}`
      });
      if (entry.isDirectory()) queue.push(child);
    }
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return { rows, truncated };
}

async function inspectCookies(directory, canary) {
  const candidates = ['Default/Network/Cookies', 'Default/Cookies'];
  for (const relative of candidates) {
    const target = path.join(directory, relative);
    const stat = await statOrNull(target);
    if (!stat?.isFile() || stat.size < 16) continue;
    const bytes = await fs.readFile(target);
    const header = bytes.subarray(0, 16).toString('latin1');
    const canaryBytes = canary ? Buffer.from(String(canary), 'utf8') : null;
    return {
      path: relative,
      bytes: stat.size,
      sha256: sha256(bytes),
      sqliteHeader: header === 'SQLite format 3\u0000',
      canaryPlaintextFound: canaryBytes ? bytes.includes(canaryBytes) : null,
      journalPresence: {
        journal: Boolean(await statOrNull(`${target}-journal`)),
        wal: Boolean(await statOrNull(`${target}-wal`))
      }
    };
  }
  return null;
}

async function inspectLocalState(directory) {
  const target = path.join(directory, 'Local State');
  const stat = await statOrNull(target);
  if (!stat?.isFile()) return { present: false };
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    parsed = null;
  }
  const osCrypt = parsed?.os_crypt ?? null;
  const encryptedKey = osCrypt?.encrypted_key;
  return {
    present: true,
    bytes: stat.size,
    parses: parsed !== null,
    osCryptKeyNames: osCrypt && typeof osCrypt === 'object' ? Object.keys(osCrypt).sort() : [],
    // Presence and length only. The key material itself is never read out.
    encryptedKey: {
      present: typeof encryptedKey === 'string',
      base64Length: typeof encryptedKey === 'string' ? encryptedKey.length : 0
    }
  };
}

function searchKeys(value, prefix = '', depth = 0, found = []) {
  if (!value || typeof value !== 'object' || depth > 2) return found;
  for (const [key, child] of Object.entries(value)) {
    const path_ = prefix ? `${prefix}.${key}` : key;
    if (/search|template|provider/i.test(key)) {
      found.push({ path: path_, type: Array.isArray(child) ? 'array' : typeof child });
    }
    searchKeys(child, path_, depth + 1, found);
  }
  return found;
}

async function inspectPreferences(directory) {
  const target = path.join(directory, 'Default/Preferences');
  const stat = await statOrNull(target);
  if (!stat?.isFile()) return { present: false };
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    parsed = null;
  }
  const topLevel = parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : [];
  return {
    present: true,
    bytes: stat.size,
    parses: parsed !== null,
    topLevelKeys: topLevel.slice(0, 80),
    searchKeyPaths: parsed ? searchKeys(parsed).slice(0, 40) : [],
    // Presence only; the provider template is never copied.
    defaultSearchProviderDataPresent: Boolean(
      parsed?.default_search_provider_data ?? parsed?.default_search_provider
    )
  };
}

async function dirSummary(directory, relative) {
  const target = path.join(directory, relative);
  const stat = await statOrNull(target);
  if (!stat?.isDirectory()) return { present: false };
  const entries = await fs.readdir(target);
  let bytes = 0;
  for (const entry of entries) {
    const child = await statOrNull(path.join(target, entry));
    if (child?.isFile()) bytes += child.size;
  }
  return { present: true, entries: entries.length, bytes };
}

export async function inspectProfile(directory, { canary = null } = {}) {
  await assertOwnedProfile(directory);
  const tree = await treeMetadata(directory);
  const cookies = await inspectCookies(directory, canary);
  const localState = await inspectLocalState(directory);
  const preferences = await inspectPreferences(directory);
  const localStore = await dirSummary(directory, 'Default/Local Storage/leveldb');
  const indexedDb = await dirSummary(directory, 'Default/IndexedDB');
  // Engine-owned state files at the profile root: size and mode only, and no
  // name is copied, so an arbitrary build's private file naming is not recorded.
  const stateFiles = await topLevelStateFiles(directory);
  return {
    directory,
    files: tree,
    cookies,
    localState,
    preferences,
    localStore,
    indexedDb,
    stateFiles
  };
}

async function topLevelStateFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return { present: false, count: 0, files: [] };
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('.') || SKIP_COPY.has(entry.name)) continue;
    if (!entry.isFile()) continue;
    const stat = await statOrNull(path.join(directory, entry.name));
    if (!stat?.isFile()) continue;
    files.push({ bytes: stat.size, mode: `0${(stat.mode & 0o777).toString(8)}` });
  }
  return { present: files.length > 0, count: files.length, files };
}

// Cookie metadata for reports: never the stored value.
export function cookieMetadata(cookie) {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    valueLength: typeof cookie.value === 'string' ? cookie.value.length : 0,
    valueDigest: typeof cookie.value === 'string' ? sha256(Buffer.from(cookie.value)) : null
  };
}
