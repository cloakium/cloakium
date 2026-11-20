// Multi-display availability.
//
// `getScreenDetails()` prompts when the permission is undecided, and a probe must
// not hang a sequential harness on a modal. The call is made only when the
// permission is already granted; otherwise presence and permission state are
// recorded and the enumeration is a declared coverage gap.

import { finish, prepare, recorder, settle } from '../support/common.mjs';

const probe = {
  id: 'screen-multidisplay',
  family: 'screen',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Never prompts. Enumeration runs only if window-management is already granted.',
    checks: [
      'multidisplay/get-screen-details-present',
      'multidisplay/is-extended-boolean',
      'multidisplay/permission-state-readable',
      'multidisplay/details-consistent-when-granted',
      'multidisplay/screen-count-matches-extended'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const base = await page.evaluate(async () => {
      let permission = null;
      try {
        const status = await navigator.permissions.query({ name: 'window-management' });
        permission = status.state;
      } catch (error) {
        permission = { error: error.name };
      }
      return {
        hasGetScreenDetails: typeof screen.getScreenDetails === 'function',
        isExtended: typeof screen.isExtended === 'boolean' ? screen.isExtended : null,
        permission
      };
    });

    rec.expect('multidisplay/is-extended-boolean', typeof base.isExtended === 'boolean', base.isExtended);
    rec.expect(
      'multidisplay/permission-state-readable',
      ['granted', 'denied', 'prompt'].includes(base.permission),
      base.permission
    );
    if (!base.hasGetScreenDetails) {
      rec.unknown('multidisplay/get-screen-details-present', 'screen.getScreenDetails is absent');
      rec.unknown('multidisplay/details-consistent-when-granted', 'screen.getScreenDetails is absent');
      rec.unknown('multidisplay/screen-count-matches-extended', 'screen.getScreenDetails is absent');
      rec.limit('screen-details-absent', 'The context does not expose the Window Management API');
      return finish(rec, base);
    }
    rec.expect('multidisplay/get-screen-details-present', true);

    if (base.permission !== 'granted') {
      rec.unknown('multidisplay/details-consistent-when-granted', {
        permission: base.permission,
        reason: 'not granting to avoid a modal prompt'
      });
      rec.unknown('multidisplay/screen-count-matches-extended', {
        permission: base.permission,
        reason: 'not granting to avoid a modal prompt'
      });
      rec.limit('screen-details-not-permitted', 'window-management is not granted; enumeration skipped');
      return finish(rec, base);
    }

    const details = await settle(
      page.evaluate(async () => {
        const granted = await screen.getScreenDetails();
        return {
          count: granted.screens.length,
          current: {
            width: granted.currentScreen.width,
            height: granted.currentScreen.height,
            isPrimary: granted.currentScreen.isPrimary,
            isInternal: granted.currentScreen.isInternal,
            devicePixelRatio: granted.currentScreen.devicePixelRatio
          },
          screens: granted.screens.map((entry) => ({
            width: entry.width,
            height: entry.height,
            isPrimary: entry.isPrimary,
            isInternal: entry.isInternal,
            devicePixelRatio: entry.devicePixelRatio
          }))
        };
      }),
      5_000,
      'getScreenDetails'
    );

    if (!details.ok) {
      rec.unknown('multidisplay/details-consistent-when-granted', details.error);
      rec.unknown('multidisplay/screen-count-matches-extended', details.error);
      rec.limit('screen-details-failed', details.error);
      return finish(rec, base);
    }
    const value = details.value;
    rec.expect(
      'multidisplay/details-consistent-when-granted',
      value.count >= 1 &&
        value.count === value.screens.length &&
        value.screens.every((entry) => entry.width > 0 && entry.height > 0 && entry.devicePixelRatio > 0),
      value
    );
    rec.expect(
      'multidisplay/screen-count-matches-extended',
      base.isExtended === (value.count > 1),
      { isExtended: base.isExtended, count: value.count }
    );

    return finish(rec, { ...base, details: value });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
