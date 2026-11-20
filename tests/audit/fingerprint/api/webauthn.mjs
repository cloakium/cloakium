// WebAuthn capability surface.
//
// Only promise-returning capability queries are used; no credential is created and
// no authenticator UI is triggered. A platform authenticator may legitimately be
// absent, which is reported as a boolean rather than a failure.

import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'api-webauthn',
  family: 'api',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none (no credential request)',
    viewport: 'any',
    notes: 'Capability queries only; no navigator.credentials.create/get call.',
    checks: [
      'webauthn/api-present',
      'webauthn/uvpaa-boolean',
      'webauthn/conditional-mediation',
      'webauthn/client-capabilities'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      const credential = window.PublicKeyCredential;
      if (typeof credential !== 'function') return { present: false };
      let uvpaa = null;
      let uvpaaError = null;
      try {
        uvpaa = await Promise.race([
          credential.isUserVerifyingPlatformAuthenticatorAvailable(),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000))
        ]);
      } catch (error) {
        uvpaaError = error.name;
      }
      let conditional = null;
      if (typeof credential.isConditionalMediationAvailable === 'function') {
        conditional = await credential.isConditionalMediationAvailable().catch(() => null);
      }
      let capabilities = null;
      if (typeof credential.getClientCapabilities === 'function') {
        capabilities = await credential.getClientCapabilities().catch(() => null);
      }
      return {
        present: true,
        uvpaa,
        uvpaaError,
        conditional,
        capabilities,
        hasCreate: typeof navigator.credentials?.create === 'function',
        hasGet: typeof navigator.credentials?.get === 'function'
      };
    });

    if (!observed.present) {
      rec.unknown('webauthn/api-present', 'PublicKeyCredential absent');
      rec.unknown('webauthn/uvpaa-boolean', 'PublicKeyCredential absent');
      rec.unknown('webauthn/conditional-mediation', 'PublicKeyCredential absent');
      rec.unknown('webauthn/client-capabilities', 'PublicKeyCredential absent');
      rec.limit('webauthn-absent', 'PublicKeyCredential is not exposed');
      return finish(rec, observed);
    }

    rec.expect('webauthn/api-present', observed.hasCreate && observed.hasGet);
    if (observed.uvpaa === 'timeout' || observed.uvpaa === null) {
      rec.unknown('webauthn/uvpaa-boolean', observed.uvpaaError ?? 'query timed out');
      rec.limit('uvpaa-query-timeout', 'isUserVerifyingPlatformAuthenticatorAvailable did not settle');
    } else {
      rec.expect('webauthn/uvpaa-boolean', typeof observed.uvpaa === 'boolean', observed.uvpaa);
    }
    if (observed.conditional === null) {
      rec.unknown('webauthn/conditional-mediation', 'isConditionalMediationAvailable absent');
    } else {
      rec.expect('webauthn/conditional-mediation', typeof observed.conditional === 'boolean', observed.conditional);
    }
    if (observed.capabilities === null) {
      rec.unknown('webauthn/client-capabilities', 'getClientCapabilities absent');
    } else {
      rec.expect(
        'webauthn/client-capabilities',
        typeof observed.capabilities === 'object' && Object.keys(observed.capabilities).length > 0,
        observed.capabilities
      );
    }

    return finish(rec, observed);
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
