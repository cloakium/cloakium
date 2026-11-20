// Fresh-profile isolation: a brand-new user-data-dir must contain none of the
// canary written into a different profile, and the source profile must still
// retain it (otherwise the isolation check would pass vacuously).

import { recorder, finish } from '../lib/recorder.mjs';
import { CANARY, cookieFor, pageSpec } from '../lib/canary.mjs';
import { readCanary, storageInventory, writeCanary } from '../lib/page.mjs';
import { cookieMetadata } from '../lib/profile.mjs';

export const scenario = {
  id: 'profile-isolation',
  timeoutMs: 90_000,
  checks: [
    'profile/isolation-cookie-absent',
    'profile/isolation-localstorage-absent',
    'profile/isolation-indexeddb-absent',
    'profile/isolation-inventory-empty',
    'profile/isolation-source-retains-canary'
  ],

  async run({ lab, server, log }) {
    const rec = recorder();
    const spec = pageSpec();
    const source = await lab.createProfile('isolation-source');
    const clean = await lab.createProfile('isolation-clean');

    const writer = await lab.open({ label: 'isolation-write', directory: source });
    try {
      await writer.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await writer.context.addCookies([cookieFor(server.origin)]);
      await writeCanary(writer.page, spec);
    } finally {
      await lab.close();
    }

    const fresh = await lab.open({ label: 'isolation-clean', directory: clean });
    let freshState;
    try {
      await fresh.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      freshState = await readCanary(fresh.page, spec);
      const cookies = await fresh.context.cookies(server.origin);
      const inventory = await storageInventory(fresh.page);
      rec.expect('profile/isolation-cookie-absent', !cookies.some((entry) => entry.name === CANARY.cookieName), {
        cookies: cookies.map(cookieMetadata)
      });
      rec.expect('profile/isolation-localstorage-absent', freshState.local.present === false, freshState.local);
      rec.expect('profile/isolation-indexeddb-absent', freshState.indexedDb.status !== 'found', freshState.indexedDb);
      rec.expect(
        'profile/isolation-inventory-empty',
        inventory.localStorageKeys.length === 0 && (inventory.databases === null || inventory.databases.length === 0),
        inventory
      );
    } finally {
      await lab.close();
    }

    const check = await lab.open({ label: 'isolation-source-reopen', directory: source });
    try {
      await check.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      const state = await readCanary(check.page, spec);
      rec.expect(
        'profile/isolation-source-retains-canary',
        state.local.matches === true && state.indexedDb.matches === true,
        state
      );
      log(`isolation: freshLocal=${freshState?.local.present} sourceRetained=${state.local.matches}`);
      return finish(rec, { source, clean, freshState });
    } finally {
      await lab.close();
    }
  }
};
