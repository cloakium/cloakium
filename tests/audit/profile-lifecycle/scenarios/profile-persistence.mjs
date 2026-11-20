// Persistence across a clean close and reopen of the same profile directory:
// cookies, localStorage and IndexedDB, each with a write-control read before the
// close so a later absence cannot be mistaken for a persistence failure.

import { recorder, finish } from '../lib/recorder.mjs';
import { CANARY, cookieFor, pageSpec, canaryMatches } from '../lib/canary.mjs';
import { cookieMetadata } from '../lib/profile.mjs';
import { readCanary, writeCanary } from '../lib/page.mjs';
import { unixSeconds } from '../lib/deadline.mjs';

export const scenario = {
  id: 'profile-persistence',
  timeoutMs: 90_000,
  checks: [
    'profile/cookie-write-visible',
    'profile/localstorage-write-visible',
    'profile/indexeddb-write-visible',
    'profile/canary-cookie-expiry-explicit',
    'profile/cookie-persists-reopen',
    'profile/localstorage-persists-reopen',
    'profile/indexeddb-persists-reopen'
  ],

  async run({ lab, server, log }) {
    const rec = recorder();
    const spec = pageSpec();
    const directory = await lab.createProfile('persistence');
    const cookie = cookieFor(server.origin);

    const first = await lab.open({ label: 'persistence-write', directory });
    let beforeClose;
    try {
      await first.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await first.context.addCookies([cookie]);
      beforeClose = await writeCanary(first.page, spec);
      const cookies = await first.context.cookies(server.origin);
      const stored = cookies.find((entry) => entry.name === CANARY.cookieName);
      rec.expect('profile/cookie-write-visible', canaryMatches(stored), stored ? cookieMetadata(stored) : null);
      rec.expect('profile/localstorage-write-visible', beforeClose.localStorage === true);
      rec.expect('profile/indexeddb-write-visible', beforeClose.indexedDb === true);
      rec.expect(
        'profile/canary-cookie-expiry-explicit',
        Boolean(stored) && stored.expires > unixSeconds() && stored.expires !== -1,
        { expires: stored?.expires ?? null, now: unixSeconds() }
      );
    } finally {
      await lab.close();
    }
    const closedAt = new Date().toISOString();

    const second = await lab.open({ label: 'persistence-reopen', directory });
    try {
      await second.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      const after = await readCanary(second.page, spec);
      const cookies = await second.context.cookies(server.origin);
      const stored = cookies.find((entry) => entry.name === CANARY.cookieName);
      rec.expect('profile/cookie-persists-reopen', canaryMatches(stored), stored ? cookieMetadata(stored) : null);
      rec.expect('profile/localstorage-persists-reopen', after.local.matches === true, after.local);
      rec.expect('profile/indexeddb-persists-reopen', after.indexedDb.matches === true, after.indexedDb);
      log(`persistence: cookie=${canaryMatches(stored)} local=${after.local.matches} idb=${after.indexedDb.status}`);
      return finish(rec, {
        directory,
        cookie: stored ? cookieMetadata(stored) : null,
        beforeClose,
        afterReopen: after,
        closedAt
      });
    } finally {
      await lab.close();
    }
  }
};
