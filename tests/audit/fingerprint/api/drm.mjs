// Encrypted Media Extensions availability.
//
// ClearKey is a built-in, network-free key system, so it is safe to request. No
// other key system is requested: a request can trigger a CDM component download,
// which would break the no-external-network rule of these probes.

import { finish, prepare, recorder } from '../support/common.mjs';

const CLEARKEY = 'org.w3.clearkey';
const CLEARKEY_CONFIG = [
  {
    initDataTypes: ['keyids'],
    audioCapabilities: [{ contentType: 'audio/webm; codecs="vorbis"' }],
    videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }],
    distinctiveIdentifier: 'not-allowed',
    persistentState: 'not-allowed',
    sessionTypes: ['temporary']
  }
];

const probe = {
  id: 'api-drm',
  family: 'api',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Only ClearKey is requested. Widevine/PlayReady are recorded as not-probed to avoid a CDM download.',
    checks: [
      'drm/eme-present',
      'drm/clearkey-available',
      'drm/clearkey-configuration-shape',
      'drm/clearkey-request-deterministic'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async ({ keySystem, configuration }) => {
        const present =
          typeof navigator.requestMediaKeySystemAccess === 'function' &&
          typeof MediaKeys !== 'undefined' &&
          typeof MediaKeySession !== 'undefined';
        if (!present) return { present: false };
        const request = async () => {
          try {
            const access = await navigator.requestMediaKeySystemAccess(keySystem, configuration);
            return {
              ok: true,
              keySystem: access.keySystem,
              configuration: access.getConfiguration
                ? {
                    initDataTypes: access.getConfiguration().initDataTypes,
                    sessionTypes: access.getConfiguration().sessionTypes ?? null,
                    persistentState: access.getConfiguration().persistentState ?? null
                  }
                : null
            };
          } catch (error) {
            return { ok: false, error: `${error.name}: ${error.message}` };
          }
        };
        const first = await request();
        const second = await request();
        return { present, first, second };
      },
      { keySystem: CLEARKEY, configuration: CLEARKEY_CONFIG }
    );

    if (!observed.present) {
      rec.unknown('drm/eme-present', 'EME API absent');
      rec.unknown('drm/clearkey-available', 'EME API absent');
      rec.unknown('drm/clearkey-configuration-shape', 'EME API absent');
      rec.unknown('drm/clearkey-request-deterministic', 'EME API absent');
      rec.limit('eme-api-absent', 'requestMediaKeySystemAccess/MediaKeys are not exposed');
      return finish(rec, observed);
    }

    rec.expect('drm/eme-present', true);
    const first = observed.first;
    if (!first.ok) {
      rec.expect('drm/clearkey-available', false, first.error);
      rec.unknown('drm/clearkey-configuration-shape', first.error);
      rec.unknown('drm/clearkey-request-deterministic', first.error);
      rec.limit('clearkey-unavailable', first.error);
      return finish(rec, observed);
    }

    rec.expect('drm/clearkey-available', true);
    rec.expect(
      'drm/clearkey-configuration-shape',
      first.keySystem === CLEARKEY &&
        Array.isArray(first.configuration?.initDataTypes) &&
        first.configuration.initDataTypes.includes('keyids'),
      first.configuration
    );
    rec.expect('drm/clearkey-request-deterministic', JSON.stringify(first) === JSON.stringify(observed.second));
    rec.limit(
      'other-key-systems-not-probed',
      'Widevine/PlayReady/FairPlay were not requested; a request can trigger a CDM component download'
    );

    return finish(rec, { first, second: observed.second, probedKeySystems: [CLEARKEY] });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
