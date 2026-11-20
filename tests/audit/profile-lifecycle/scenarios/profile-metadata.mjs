// Metadata-only profile inspection after a clean close.
//
// Reads file sizes/modes, the SQLite header of the cookie store, and JSON key
// names. It never reads a key value, never decrypts a cookie, and treats a
// missing os_crypt.encrypted_key on Linux as a coverage note, not a defect.

import { recorder, finish } from '../lib/recorder.mjs';
import { CANARY, cookieFor, pageSpec } from '../lib/canary.mjs';
import { inspectProfile } from '../lib/profile.mjs';
import { writeCanary } from '../lib/page.mjs';

export const scenario = {
  id: 'profile-metadata',
  timeoutMs: 75_000,
  checks: [
    'metadata/cookies-db-present',
    'metadata/cookies-db-sqlite-header',
    'metadata/cookies-value-not-plaintext',
    'metadata/local-state-parses',
    'metadata/encrypted-key-shape-or-absent-on-linux',
    'metadata/local-storage-store-present',
    'metadata/indexeddb-store-present',
    'metadata/preferences-present',
    'metadata/state-file-recorded'
  ],

  async run({ lab, server, log }) {
    const rec = recorder();
    const directory = await lab.createProfile('metadata');
    const writer = await lab.open({ label: 'metadata-write', directory });
    try {
      await writer.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await writer.context.addCookies([cookieFor(server.origin)]);
      await writeCanary(writer.page, pageSpec());
    } finally {
      await lab.close();
    }

    const profile = await inspectProfile(directory, { canary: CANARY.cookieValue });
    const cookies = profile.cookies;
    rec.expect(
      'metadata/cookies-db-present',
      Boolean(cookies),
      cookies ? { path: cookies.path, bytes: cookies.bytes } : { reason: 'not found' }
    );
    if (!cookies) {
      rec.unknown('metadata/cookies-db-sqlite-header', 'cookies database not found');
      rec.unknown('metadata/cookies-value-not-plaintext', 'cookies database not found');
      rec.limit('cookies-db-absent', 'No Default/Network/Cookies or Default/Cookies file after a clean close');
    } else {
      rec.expect('metadata/cookies-db-sqlite-header', cookies.sqliteHeader === true);
      rec.expect('metadata/cookies-value-not-plaintext', cookies.canaryPlaintextFound === false, {
        canaryPlaintextFound: cookies.canaryPlaintextFound
      });
    }

    rec.expect('metadata/local-state-parses', profile.localState.present && profile.localState.parses === true, {
      present: profile.localState.present,
      bytes: profile.localState.bytes ?? null
    });
    const key = profile.localState.encryptedKey;
    if (!key?.present) {
      rec.unknown('metadata/encrypted-key-shape-or-absent-on-linux', 'os_crypt.encrypted_key absent');
      rec.limit(
        'linux-local-state-key-absent-is-not-a-defect',
        'Linux does not require a Windows-style Local State os_crypt key'
      );
    } else {
      rec.expect(
        'metadata/encrypted-key-shape-or-absent-on-linux',
        key.base64Length >= 16 && key.base64Length <= 4096,
        { base64Length: key.base64Length, keyNames: profile.localState.osCryptKeyNames }
      );
    }

    rec.expect('metadata/local-storage-store-present', profile.localStore.present === true, profile.localStore);
    rec.expect('metadata/indexeddb-store-present', profile.indexedDb.present === true, profile.indexedDb);

    if (!profile.preferences.present) {
      rec.unknown('metadata/preferences-present', 'Default/Preferences not written');
      rec.limit('preferences-absent', 'The engine did not write Default/Preferences for this profile');
    } else {
      rec.expect('metadata/preferences-present', profile.preferences.parses === true, {
        bytes: profile.preferences.bytes
      });
    }

    if (!profile.stateFiles.present) {
      rec.unknown('metadata/state-file-recorded', 'no engine state file at the profile root');
      rec.limit('engine-state-file-absent', 'A build need not write a root-level state file; absence is not a native defect');
    } else {
      rec.expect('metadata/state-file-recorded', profile.stateFiles.count > 0, {
        count: profile.stateFiles.count,
        files: profile.stateFiles.files
      });
    }

    log(`metadata: files=${profile.files.rows.length} cookies=${cookies?.path ?? 'absent'}`);
    return finish(rec, {
      directory,
      fileCount: profile.files.rows.length,
      filesTruncated: profile.files.truncated,
      cookies,
      localState: profile.localState,
      preferences: profile.preferences,
      localStore: profile.localStore,
      indexedDb: profile.indexedDb,
      stateFiles: profile.stateFiles
    });
  }
};
