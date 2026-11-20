// Navigator hardware and meta surface.
//
// Reads the documented JS-visible navigator fields twice and checks only
// internal coherence: nothing here assumes a particular host, persona or seed.
// A persona that changes platform/UA must change all of them together, which is
// exactly what these implications assert.

import { finish, prepare, recorder } from '../support/common.mjs';

// Optional caller-declared navigator contract. Only these documented fields are
// honoured; each present field yields a deterministic explicit check. The
// generic "sane" checks above remain diagnostics, never proof that a requested
// value was applied.
const EXPLICIT_FIELDS = [
  ['hardwareConcurrency', 'navigator/explicit-hardware-concurrency-matches'],
  ['deviceMemory', 'navigator/explicit-device-memory-matches'],
  ['maxTouchPoints', 'navigator/explicit-max-touch-points-matches'],
  ['language', 'navigator/explicit-language-matches']
];

function isJsonPrimitive(value) {
  return value !== null && ['string', 'number', 'boolean'].includes(typeof value);
}

// OS token implied by the UA string, and the navigator.platform prefixes that are
// coherent with it. Unknown UA families are recorded, not failed.
function osToken(userAgent) {
  if (/Windows NT/i.test(userAgent)) return 'windows';
  if (/Android/i.test(userAgent)) return 'android';
  if (/CrOS/i.test(userAgent)) return 'chromeos';
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(userAgent)) return 'apple';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return 'unknown';
}

function platformCoherent(token, platform) {
  if (token === 'unknown' || typeof platform !== 'string') return null;
  if (token === 'windows') return /^Win/.test(platform);
  if (token === 'apple') return /^Mac/.test(platform);
  if (token === 'linux') return /^Linux/.test(platform);
  if (token === 'android') return /^(Linux|Android)/.test(platform);
  if (token === 'chromeos') return /^(Linux|CrOS)/.test(platform);
  return null;
}

const probe = {
  id: 'navigator-core',
  family: 'navigator',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Read-only; safe before any input. Storage estimate is bounded. Conditional checks navigator/explicit-<field>-matches appear only when config.expectedNavigator declares that field (hardwareConcurrency, deviceMemory, maxTouchPoints, language).',
    checks: [
      'navigator/ua-non-empty',
      'navigator/ua-no-headless-token',
      'navigator/webdriver-false',
      'navigator/languages-coherent',
      'navigator/platform-non-empty',
      'navigator/platform-coherent-with-ua',
      'navigator/vendor-google',
      'navigator/hardware-concurrency-sane',
      'navigator/device-memory-standard',
      'navigator/max-touch-points-sane',
      'navigator/storage-quota-above-usage',
      'navigator/user-activation-coherent',
      'navigator/plugins-mime-coherent',
      'navigator/repeated-read-stable',
      'navigator/explicit-hardware-concurrency-matches',
      'navigator/explicit-device-memory-matches',
      'navigator/explicit-max-touch-points-matches',
      'navigator/explicit-language-matches'
    ],
    conditionalChecks: {
      'navigator/explicit-hardware-concurrency-matches': 'config.expectedNavigator.hardwareConcurrency',
      'navigator/explicit-device-memory-matches': 'config.expectedNavigator.deviceMemory',
      'navigator/explicit-max-touch-points-matches': 'config.expectedNavigator.maxTouchPoints',
      'navigator/explicit-language-matches': 'config.expectedNavigator.language'
    }
  },

  async run({ page, origin, config = {} }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      const read = async () => {
        let estimate = null;
        try {
          const quota = await Promise.race([
            navigator.storage.estimate(),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000))
          ]);
          estimate = quota.timedOut
            ? { timedOut: true }
            : { quota: quota.quota ?? null, usage: quota.usage ?? null };
        } catch (error) {
          estimate = { error: error.name };
        }
        const connection = navigator.connection
          ? {
              effectiveType: navigator.connection.effectiveType ?? null,
              rtt: navigator.connection.rtt ?? null,
              downlink: navigator.connection.downlink ?? null,
              saveData: navigator.connection.saveData ?? null,
              type: navigator.connection.type ?? null
            }
          : null;
        return {
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
          appName: navigator.appName,
          appCodeName: navigator.appCodeName,
          product: navigator.product,
          vendor: navigator.vendor,
          platform: navigator.platform,
          language: navigator.language,
          languages: navigator.languages ? [...navigator.languages] : [],
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          deviceMemory: navigator.deviceMemory ?? null,
          maxTouchPoints: navigator.maxTouchPoints ?? null,
          cookieEnabled: navigator.cookieEnabled ?? null,
          onLine: navigator.onLine ?? null,
          pdfViewerEnabled: navigator.pdfViewerEnabled ?? null,
          doNotTrack: navigator.doNotTrack ?? null,
          webdriver: navigator.webdriver ?? null,
          userAgentData: navigator.userAgentData
            ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
            : null,
          userActivation: navigator.userActivation
            ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
            : null,
          pluginCount: navigator.plugins.length,
          plugins: [...navigator.plugins].map((plugin) => plugin.name),
          mimeTypes: [...navigator.mimeTypes].map((mime) => mime.type),
          pluginMimesNested: [...navigator.plugins].every((plugin) =>
            [...plugin].every((mime) => [...navigator.mimeTypes].some((known) => known.type === mime.type))
          ),
          connection,
          estimate
        };
      };
      const first = await read();
      const second = await read();
      return { first, second };
    });

    const first = observed.first;
    const token = osToken(first.userAgent);
    const platformVerdict = platformCoherent(token, first.platform);
    const memoryStandard = [0.25, 0.5, 1, 2, 4, 8].includes(first.deviceMemory);

    rec.expect('navigator/ua-non-empty', typeof first.userAgent === 'string' && first.userAgent.length > 20);
    rec.expect('navigator/ua-no-headless-token', !/headless/i.test(first.userAgent));
    rec.expect('navigator/webdriver-false', first.webdriver === false);
    rec.expect(
      'navigator/languages-coherent',
      Array.isArray(first.languages) &&
        first.languages.length > 0 &&
        first.languages[0] === first.language &&
        first.languages.every((tag) => typeof tag === 'string' && tag.length >= 2)
    );
    rec.expect('navigator/platform-non-empty', typeof first.platform === 'string' && first.platform.length > 0);
    if (platformVerdict === null) {
      rec.unknown('navigator/platform-coherent-with-ua', { osToken: token, platform: first.platform });
    } else {
      rec.expect('navigator/platform-coherent-with-ua', platformVerdict, { osToken: token, platform: first.platform });
    }
    rec.expect('navigator/vendor-google', first.vendor === 'Google Inc.');
    rec.expect(
      'navigator/hardware-concurrency-sane',
      Number.isInteger(first.hardwareConcurrency) && first.hardwareConcurrency >= 1 && first.hardwareConcurrency <= 1024,
      first.hardwareConcurrency
    );
    if (first.deviceMemory === null) {
      rec.unknown('navigator/device-memory-standard', 'navigator.deviceMemory is absent');
      rec.limit('device-memory-absent', 'deviceMemory is not exposed on this context');
    } else if (memoryStandard) {
      rec.expect('navigator/device-memory-standard', true, first.deviceMemory);
    } else if (Number.isFinite(first.deviceMemory) && first.deviceMemory > 0 && first.deviceMemory <= 64) {
      rec.unknown('navigator/device-memory-standard', {
        value: first.deviceMemory,
        reason: 'outside the documented 0.25/0.5/1/2/4/8 GiB bucket set'
      });
      rec.limit('device-memory-unbucketed', 'deviceMemory reports a value outside the documented bucket set');
    } else {
      rec.expect('navigator/device-memory-standard', false, first.deviceMemory);
    }
    rec.expect(
      'navigator/max-touch-points-sane',
      Number.isInteger(first.maxTouchPoints) && first.maxTouchPoints >= 0 && first.maxTouchPoints <= 100,
      first.maxTouchPoints
    );
    if (!first.estimate || first.estimate.timedOut || typeof first.estimate.quota !== 'number') {
      rec.unknown('navigator/storage-quota-above-usage', first.estimate);
      rec.limit('storage-estimate-unavailable', 'navigator.storage.estimate() did not report a numeric quota');
    } else {
      rec.expect(
        'navigator/storage-quota-above-usage',
        first.estimate.quota > 0 && first.estimate.quota >= (first.estimate.usage ?? 0),
        first.estimate
      );
    }
    if (first.userActivation === null) {
      rec.unknown('navigator/user-activation-coherent', 'navigator.userActivation is absent');
    } else {
      rec.expect(
        'navigator/user-activation-coherent',
        first.userActivation.isActive === false || first.userActivation.hasBeenActive === true,
        first.userActivation
      );
    }
    rec.expect(
      'navigator/plugins-mime-coherent',
      first.pluginCount === first.plugins.length && first.pluginMimesNested === true,
      { pluginCount: first.pluginCount, plugins: first.plugins }
    );
    rec.expect(
      'navigator/repeated-read-stable',
      JSON.stringify(first) === JSON.stringify(observed.second)
    );

    // Caller-declared requested values. Absence of config.expectedNavigator keeps
    // the normal suite exactly as before: no extra checks, no extra gaps.
    const expectations = config?.expectedNavigator;
    const declared = expectations && typeof expectations === 'object' && !Array.isArray(expectations);
    const evaluated = [];
    if (declared) {
      const unknownFields = Object.keys(expectations).filter((field) => !EXPLICIT_FIELDS.some(([known]) => known === field));
      if (unknownFields.length) rec.limit('explicit-expectation-unsupported-field', unknownFields.sort());
      for (const [field, name] of EXPLICIT_FIELDS) {
        if (!Object.hasOwn(expectations, field)) continue;
        const requested = expectations[field];
        const actual = first[field] ?? null;
        if (!isJsonPrimitive(requested)) {
          rec.unknown(name, { requested, actual, reason: 'requested value is not a JSON primitive' });
          rec.limit('explicit-expectation-invalid', { field, requested });
          evaluated.push({ field, requested, actual, status: 'invalid-request' });
          continue;
        }
        if (actual === null || actual === undefined) {
          rec.unknown(name, { requested, actual: null, reason: 'API not exposed in this realm' });
          rec.limit('explicit-field-unavailable', { field, requested });
          evaluated.push({ field, requested, actual: null, status: 'unavailable' });
          continue;
        }
        const matches = actual === requested;
        rec.expect(name, matches, { field, requested, actual });
        evaluated.push({ field, requested, actual, status: matches ? 'match' : 'mismatch' });
      }
    }

    return finish(rec, {
      osToken: token,
      navigator: first,
      secondReadDigestEqual: JSON.stringify(first) === JSON.stringify(observed.second),
      expectedNavigator: {
        source: declared ? 'config-declared' : 'not-declared',
        requested: declared ? { ...expectations } : null,
        evaluated
      }
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
