// storageState export and import through the documented Playwright API:
// `context.storageState({ path, indexedDB })` and `context.setStorageState(path)`,
// restored into a different, freshly created persistent profile.

import fs from 'node:fs/promises';
import path from 'node:path';
import { recorder, finish } from '../lib/recorder.mjs';
import { CANARY, cookieFor, pageSpec } from '../lib/canary.mjs';
import { readCanary, writeCanary } from '../lib/page.mjs';
import { sha256 } from '../lib/profile.mjs';
import { settle } from '../lib/deadline.mjs';

export const scenario = {
  id: 'storage-state',
  timeoutMs: 90_000,
  checks: [
    'storage-state/export-file-written',
    'storage-state/export-cookie-present',
    'storage-state/export-localstorage-present',
    'storage-state/export-indexeddb-present',
    'storage-state/import-cookie-restored',
    'storage-state/import-localstorage-restored',
    'storage-state/import-indexeddb-restored',
    'storage-state/import-uses-different-profile'
  ],

  async run({ lab, server, workRoot, log }) {
    const rec = recorder();
    const spec = pageSpec();
    const statePath = path.join(workRoot, 'storage-state.json');
    const source = await lab.createProfile('storage-state-source');
    const target = await lab.createProfile('storage-state-target');

    let exportWithIndexedDb = null;
    const writer = await lab.open({ label: 'storage-state-export', directory: source });
    try {
      await writer.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await writer.context.addCookies([cookieFor(server.origin)]);
      await writeCanary(writer.page, spec);
      const withIndexedDb = await settle(
        writer.context.storageState({ path: statePath, indexedDB: true }),
        15_000,
        'storageState(indexedDB)'
      );
      if (withIndexedDb.ok) {
        exportWithIndexedDb = true;
      } else {
        exportWithIndexedDb = false;
        rec.limit('indexeddb-export-unsupported', withIndexedDb.error);
        await writer.context.storageState({ path: statePath });
      }
    } finally {
      await lab.close();
    }

    const raw = await fs.readFile(statePath);
    const state = JSON.parse(raw.toString('utf8'));
    const exportedCookie = (state.cookies ?? []).find((entry) => entry.name === CANARY.cookieName) ?? null;
    const originEntry = (state.origins ?? []).find((entry) => entry.origin === server.origin) ?? null;
    const exportedLocal = originEntry?.localStorage?.some((entry) => entry.name === CANARY.localKey) ?? false;
    // Playwright stores IndexedDB per origin: origins[].indexedDB[].
    const exportedIndexedDb = Array.isArray(originEntry?.indexedDB) && originEntry.indexedDB.length > 0;

    rec.expect('storage-state/export-file-written', raw.length > 100, { bytes: raw.length });
    rec.expect('storage-state/export-cookie-present', Boolean(exportedCookie), {
      expires: exportedCookie?.expires ?? null,
      name: exportedCookie?.name ?? null
    });
    rec.expect('storage-state/export-localstorage-present', exportedLocal);
    const exportGap =
      exportWithIndexedDb === false
        ? 'indexedDB export option rejected'
        : !exportedIndexedDb
          ? 'snapshot contains no IndexedDB entries'
          : null;
    if (exportGap) {
      rec.unknown('storage-state/export-indexeddb-present', exportGap);
      if (exportWithIndexedDb !== false) {
        rec.limit('indexeddb-export-empty', 'The engine accepted indexedDB:true but produced no IndexedDB records');
      }
    } else {
      rec.expect('storage-state/export-indexeddb-present', true, {
        databases: originEntry.indexedDB.length
      });
    }
    rec.expect('storage-state/import-uses-different-profile', source !== target);

    const reader = await lab.open({ label: 'storage-state-import', directory: target });
    try {
      const restored = await settle(reader.context.setStorageState(statePath), 15_000, 'setStorageState');
      if (!restored.ok) rec.limit('storage-state-import-failed', restored.error);
      let cookies = [];
      let after = null;
      if (restored.ok) {
        await reader.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        cookies = await reader.context.cookies(server.origin);
        after = await readCanary(reader.page, spec);
      }
      const cookie = cookies.find((entry) => entry.name === CANARY.cookieName) ?? null;
      rec.expect(
        'storage-state/import-cookie-restored',
        Boolean(cookie) && cookie.value === CANARY.cookieValue,
        cookie ? { expires: cookie.expires } : restored.ok ? null : restored.error
      );
      rec.expect(
        'storage-state/import-localstorage-restored',
        after?.local.matches === true,
        after?.local ?? (restored.ok ? null : restored.error)
      );
      const importGap = !restored.ok
        ? restored.error
        : exportWithIndexedDb === false
          ? 'no IndexedDB snapshot was exported'
          : !exportedIndexedDb
            ? 'exported snapshot had no IndexedDB entries'
            : null;
      if (importGap) {
        rec.unknown('storage-state/import-indexeddb-restored', importGap);
      } else {
        rec.expect('storage-state/import-indexeddb-restored', after.indexedDb.matches === true, after.indexedDb);
      }
      log(`storage-state: cookie=${Boolean(cookie)} local=${after?.local.matches ?? false} idb=${after?.indexedDb.status ?? 'none'}`);
      return finish(rec, {
        statePath,
        bytes: raw.length,
        digest: sha256(raw),
        exportWithIndexedDb,
        importedCookieExpires: cookie?.expires ?? null,
        afterImport: after
      });
    } finally {
      await lab.close();
    }
  }
};
