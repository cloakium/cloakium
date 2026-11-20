// User-Agent Client Hints: HTTP headers versus the JS `navigator.userAgentData`
// view, plus the high-entropy metadata a persona must keep coherent.
//
// The header view is captured with a same-origin request fulfilled locally by
// the browser driver (`context.route`), so no external network is involved and
// no page property is touched. If the context cannot route, the HTTP half is
// reported as a coverage gap instead of a pass.

import { finish, prepare, recorder } from '../support/common.mjs';

const HINTS = [
  'brands',
  'fullVersionList',
  'mobile',
  'platform',
  'platformVersion',
  'architecture',
  'bitness',
  'model',
  'wow64',
  'formFactors'
];

function parseBrands(header) {
  if (!header) return null;
  return [...header.matchAll(/"([^"]+)";v="([^"]*)"/g)]
    .map((match) => ({ brand: match[1], version: match[2] }))
    .sort((left, right) => left.brand.localeCompare(right.brand));
}

const probe = {
  id: 'navigator-client-hints',
  family: 'navigator',
  budgetMs: 15_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: ['local-header-echo'],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Needs a driver that can fulfil a same-origin route. High-entropy hints may be absent by policy.',
    checks: [
      'ch/headers-captured',
      'ch/ua-header-matches-js',
      'ch/brands-match-js',
      'ch/mobile-matches-js',
      'ch/platform-matches-js',
      'ch/brands-non-empty',
      'ch/no-headless-brand',
      'ch/full-version-major-matches-ua',
      'ch/full-version-list-covers-brands',
      'ch/platform-version-shape',
      'ch/architecture-enum',
      'ch/bitness-enum',
      'ch/high-entropy-deterministic'
    ]
  },

  async run({ page, context, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const echoUrl = `${origin}/__cloakium_probe_ch_echo`;
    let headers = null;
    let routeError = null;
    let routed = false;
    try {
      await context.route(echoUrl, async (route) => {
        const sent = route.request().headers();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(sent)
        });
      });
      routed = true;
      headers = await page.evaluate(
        async (url) => {
          const response = await fetch(url, { cache: 'no-store' });
          return response.json();
        },
        echoUrl
      );
    } catch (error) {
      routeError = error.message ?? String(error);
    } finally {
      if (routed) {
        try {
          await context.unroute(echoUrl);
        } catch {
          /* unroute failure must not mask the observation */
        }
      }
    }

    const js = await page.evaluate(async (hints) => {
      const uaData = navigator.userAgentData;
      const base = uaData
        ? {
            brands: uaData.brands ? [...uaData.brands] : [],
            mobile: uaData.mobile ?? null,
            platform: uaData.platform ?? null
          }
        : null;
      let highEntropy = null;
      let highEntropyError = null;
      if (uaData?.getHighEntropyValues) {
        try {
          highEntropy = await Promise.race([
            uaData.getHighEntropyValues(hints),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 3000))
          ]);
        } catch (error) {
          highEntropyError = error.name;
        }
      }
      const repeat = uaData?.getHighEntropyValues
        ? await uaData.getHighEntropyValues(hints).catch(() => null)
        : null;
      return { base, highEntropy, highEntropyError, repeat, userAgent: navigator.userAgent };
    }, HINTS);

    if (!js.base) {
      rec.unknown('ch/headers-captured', 'navigator.userAgentData is absent');
      rec.unknown('ch/ua-header-matches-js', 'no JS client hints');
      rec.unknown('ch/brands-match-js', 'no JS client hints');
      rec.unknown('ch/mobile-matches-js', 'no JS client hints');
      rec.unknown('ch/platform-matches-js', 'no JS client hints');
      rec.unknown('ch/brands-non-empty', 'no JS client hints');
      rec.unknown('ch/no-headless-brand', 'no JS client hints');
      rec.unknown('ch/full-version-major-matches-ua', 'no JS client hints');
      rec.unknown('ch/full-version-list-covers-brands', 'no JS client hints');
      rec.unknown('ch/platform-version-shape', 'no JS client hints');
      rec.unknown('ch/architecture-enum', 'no JS client hints');
      rec.unknown('ch/bitness-enum', 'no JS client hints');
      rec.unknown('ch/high-entropy-deterministic', 'no JS client hints');
      rec.limit('client-hints-absent', 'navigator.userAgentData is not exposed by this context');
      return finish(rec, { headers, js });
    }

    if (!headers) {
      rec.unknown('ch/headers-captured', routeError ?? 'same-origin echo unavailable');
      rec.limit('header-echo-unavailable', routeError ?? 'context.route is not available');
      for (const name of [
        'ch/ua-header-matches-js',
        'ch/brands-match-js',
        'ch/mobile-matches-js',
        'ch/platform-matches-js'
      ]) {
        rec.unknown(name, 'HTTP header view unavailable');
      }
    } else {
      rec.expect('ch/headers-captured', Object.keys(headers).length > 0);
      rec.expect('ch/ua-header-matches-js', headers['user-agent'] === js.userAgent, {
        header: headers['user-agent'] ?? null
      });
      const headerBrands = parseBrands(headers['sec-ch-ua']);
      const jsBrands = [...js.base.brands].sort((left, right) => left.brand.localeCompare(right.brand));
      if (!headerBrands) {
        rec.unknown('ch/brands-match-js', 'sec-ch-ua header not sent for a same-origin fetch');
        rec.limit('sec-ch-ua-absent', 'The context did not send low-entropy client hints on fetch');
      } else {
        rec.expect('ch/brands-match-js', JSON.stringify(headerBrands) === JSON.stringify(jsBrands), {
          headerBrands
        });
      }
      const headerPlatform = (headers['sec-ch-ua-platform'] || '').replace(/"/g, '');
      if (!headers['sec-ch-ua-platform']) {
        rec.unknown('ch/platform-matches-js', 'sec-ch-ua-platform header absent');
      } else {
        rec.expect('ch/platform-matches-js', headerPlatform === js.base.platform, {
          headerPlatform,
          jsPlatform: js.base.platform
        });
      }
      if (!('sec-ch-ua-mobile' in headers)) {
        rec.unknown('ch/mobile-matches-js', 'sec-ch-ua-mobile header absent');
      } else {
        rec.expect('ch/mobile-matches-js', headers['sec-ch-ua-mobile'] === (js.base.mobile ? '?1' : '?0'), {
          header: headers['sec-ch-ua-mobile']
        });
      }
    }

    rec.expect('ch/brands-non-empty', js.base.brands.length > 0, js.base.brands);
    rec.expect(
      'ch/no-headless-brand',
      js.base.brands.every((entry) => !/headless/i.test(String(entry.brand)))
    );

    const entropy = js.highEntropy && !js.highEntropy.timedOut ? js.highEntropy : null;
    if (!entropy) {
      rec.unknown('ch/full-version-major-matches-ua', js.highEntropy?.timedOut ? 'getHighEntropyValues timed out' : js.highEntropyError);
      rec.unknown('ch/full-version-list-covers-brands', 'high-entropy values unavailable');
      rec.unknown('ch/platform-version-shape', 'high-entropy values unavailable');
      rec.unknown('ch/architecture-enum', 'high-entropy values unavailable');
      rec.unknown('ch/bitness-enum', 'high-entropy values unavailable');
      rec.unknown('ch/high-entropy-deterministic', 'high-entropy values unavailable');
      rec.limit('high-entropy-unavailable', js.highEntropyError ?? 'getHighEntropyValues returned no data');
      return finish(rec, { headers, js, entropy: null });
    }

    const uaMajor = (js.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/) ?? [])[1] ?? null;
    const fullVersion = entropy.uaFullVersion ?? null;
    if (!fullVersion || !uaMajor) {
      rec.unknown('ch/full-version-major-matches-ua', { uaFullVersion: fullVersion, uaMajor });
    } else {
      rec.expect('ch/full-version-major-matches-ua', fullVersion.split('.')[0] === uaMajor, {
        uaFullVersion: fullVersion,
        uaMajor
      });
    }
    const fullList = Array.isArray(entropy.fullVersionList) ? entropy.fullVersionList : [];
    const brandNames = new Set(js.base.brands.map((entry) => entry.brand));
    rec.expect(
      'ch/full-version-list-covers-brands',
      fullList.length > 0 && [...brandNames].every((name) => fullList.some((entry) => entry.brand === name)),
      { fullList, brands: js.base.brands }
    );
    const platformVersion = entropy.platformVersion;
    const platformVersionValid =
      typeof platformVersion === 'string' &&
      (/^\d+(\.\d+){1,3}$/.test(platformVersion) ||
        (platformVersion === '' && js.base.platform === 'Linux'));
    rec.expect('ch/platform-version-shape', platformVersionValid, {
      platformVersion,
      platform: js.base.platform
    });
    rec.expect('ch/architecture-enum', ['x86', 'arm', ''].includes(entropy.architecture ?? ''), entropy.architecture);
    rec.expect('ch/bitness-enum', ['64', '32', ''].includes(entropy.bitness ?? ''), entropy.bitness);
    rec.expect(
      'ch/high-entropy-deterministic',
      Boolean(js.repeat) && JSON.stringify(js.repeat) === JSON.stringify(entropy)
    );

    return finish(rec, { headers: headers ?? null, js, entropy });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
