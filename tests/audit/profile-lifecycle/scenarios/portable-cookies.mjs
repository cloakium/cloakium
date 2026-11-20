// Documented progressive-enhancement flag: --fingerprint-portable-cookies.
//
// Both legs are launched from the first launch, the profile is closed, copied
// while closed, and restarted from the copy on the SAME host. That proves the
// copy/restart path works; it cannot prove cross-machine portability, which is
// recorded as a limitation rather than a verdict.

import { recorder, finish } from '../lib/recorder.mjs';
import { CANARY, cookieFor } from '../lib/canary.mjs';
import { cookieMetadata, copyOwnedProfile, readOwnershipMarker } from '../lib/profile.mjs';
import { hasFlag } from '../lib/flags.mjs';

export const PORTABLE_FLAG = '--fingerprint-portable-cookies';

export const scenario = {
  id: 'portable-cookies',
  timeoutMs: 150_000,
  checks: [
    'portable/baseline-original-reopen-cookie-present',
    'portable/original-reopen-cookie-present',
    'portable/copied-profile-cookie-present',
    'portable/copied-profile-is-owned-fixture',
    'portable/flag-applied-to-portable-leg'
  ],

  async run({ lab, server, workRoot, baseArgs, log }) {
    const rec = recorder();
    const alreadyInBase = hasFlag(baseArgs, PORTABLE_FLAG);
    if (alreadyInBase) {
      rec.limit('portable-flag-already-in-base-args', 'baseArgs already contain the portable flag; the baseline leg uses the same configuration');
    }

    const seed = async (label, directory, args) => {
      const opened = await lab.open({ label, directory, args });
      try {
        await opened.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        await opened.context.addCookies([cookieFor(server.origin)]);
        const cookies = await opened.context.cookies(server.origin);
        const stored = cookies.find((entry) => entry.name === CANARY.cookieName) ?? null;
        return stored ? cookieMetadata(stored) : null;
      } finally {
        await lab.close();
      }
    };

    const readCookie = async (label, directory, args) => {
      const opened = await lab.open({ label, directory, args });
      try {
        await opened.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        const cookies = await opened.context.cookies(server.origin);
        return cookies.find((entry) => entry.name === CANARY.cookieName) ?? null;
      } finally {
        await lab.close();
      }
    };

    const baseline = await lab.createProfile('portable-baseline');
    const baselineCookie = await seed('portable-baseline-write', baseline, []);
    const baselineCopy = lab.profile('portable-baseline-copy');
    await copyOwnedProfile(baseline, baselineCopy);
    const baselineCopyCookie = await readCookie('portable-baseline-copy-read', baselineCopy, []);
    const baselineReopenCookie = await readCookie('portable-baseline-reopen', baseline, []);

    const portable = await lab.createProfile('portable-enabled');
    const portableArgs = alreadyInBase ? [] : [PORTABLE_FLAG];
    const portableCookie = await seed('portable-write', portable, portableArgs);
    const portableCopy = lab.profile('portable-enabled-copy');
    await copyOwnedProfile(portable, portableCopy);
    const portableCopyCookie = await readCookie('portable-copy-read', portableCopy, portableArgs);
    const portableReopenCookie = await readCookie('portable-reopen', portable, portableArgs);

    const portableLaunch = lab.launches.find((entry) => entry.label === 'portable-write');
    rec.expect(
      'portable/flag-applied-to-portable-leg',
      Boolean(portableLaunch) && hasFlag(portableLaunch.args, PORTABLE_FLAG),
      { args: portableLaunch?.args ?? [] }
    );
    rec.expect(
      'portable/baseline-original-reopen-cookie-present',
      Boolean(baselineReopenCookie) && Boolean(baselineCookie),
      { seeded: Boolean(baselineCookie), reopened: Boolean(baselineReopenCookie) }
    );
    rec.expect('portable/original-reopen-cookie-present', Boolean(portableReopenCookie) && Boolean(portableCookie), {
      seeded: Boolean(portableCookie),
      reopened: Boolean(portableReopenCookie)
    });
    rec.expect(
      'portable/copied-profile-cookie-present',
      Boolean(portableCopyCookie) && portableCopyCookie.value === CANARY.cookieValue,
      portableCopyCookie ? cookieMetadata(portableCopyCookie) : null
    );
    rec.expect(
      'portable/copied-profile-is-owned-fixture',
      Boolean(await readOwnershipMarker(portableCopy))
    );
    rec.limit(
      'same-host-copy-cannot-prove-cross-machine-portability',
      'Both copies were restarted on the same host and OS keyring; this does not establish machine independence'
    );
    if (!baselineCookie) rec.limit('baseline-cookie-not-persisted', 'The baseline leg did not retain its canary cookie');
    log(`portable: portableCopy=${Boolean(portableCopyCookie)} baselineCopy=${Boolean(baselineCopyCookie)}`);
    return finish(rec, {
      workRoot,
      baselineCookie,
      baselineCopyCookiePresent: Boolean(baselineCopyCookie),
      baselineReopenCookiePresent: Boolean(baselineReopenCookie),
      portableCookie,
      portableReopenCookiePresent: Boolean(portableReopenCookie),
      portableCopyCookiePresent: Boolean(portableCopyCookie),
      alreadyInBase,
      portableArgs
    });
  }
};
