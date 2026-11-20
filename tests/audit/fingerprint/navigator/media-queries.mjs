// Media queries that must agree with navigator/screen state.
//
// The checks are implications that hold for every real Chromium on every host:
// a coarse pointer needs touch points, "any" capabilities are at least as broad
// as the primary one, and the orientation query follows the viewport, not the
// display. Everything else is recorded as an observation, not a verdict.

import { finish, prepare, recorder } from '../support/common.mjs';

const STRING_QUERIES = [
  '(pointer: fine)',
  '(pointer: coarse)',
  '(pointer: none)',
  '(any-pointer: fine)',
  '(any-pointer: coarse)',
  '(hover: hover)',
  '(hover: none)',
  '(any-hover: hover)',
  '(any-hover: none)',
  '(prefers-color-scheme: light)',
  '(prefers-color-scheme: dark)',
  '(prefers-reduced-motion: no-preference)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-contrast: no-preference)',
  '(prefers-contrast: more)',
  '(forced-colors: none)',
  '(forced-colors: active)',
  '(inverted-colors: none)',
  '(color-gamut: srgb)',
  '(color-gamut: p3)',
  '(color-gamut: rec2020)',
  '(dynamic-range: standard)',
  '(dynamic-range: high)',
  '(monochrome: 0)',
  '(scripting: enabled)',
  '(display-mode: browser)',
  '(display-mode: standalone)',
  '(orientation: landscape)',
  '(orientation: portrait)'
];

const probe = {
  id: 'navigator-media-queries',
  family: 'navigator',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Resolution sampling only resolves for 1/1.25/1.5/2/3 device pixel ratios.',
    checks: [
      'mq/pointer-exclusive',
      'mq/any-pointer-present',
      'mq/coarse-implies-touch',
      'mq/hover-implies-any-hover',
      'mq/color-gamut-hierarchy',
      'mq/scripting-enabled',
      'mq/display-mode-browser',
      'mq/reduced-motion-declared',
      'mq/contrast-declared',
      'mq/resolution-matches-dpr',
      'mq/orientation-matches-viewport',
      'mq/evaluated-without-error',
      'mq/evaluation-deterministic'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async ({ queries, ratios }) => {
        const evaluate = (query) => {
          try {
            return matchMedia(query).matches;
          } catch (error) {
            return { error: error.name };
          }
        };
        const results = {};
        for (const query of queries) results[query] = evaluate(query);
        const resolutions = {};
        for (const ratio of ratios) resolutions[String(ratio)] = evaluate(`(resolution: ${ratio}dppx)`);
        const repeat = {};
        for (const query of queries) repeat[query] = evaluate(query);
        return {
          results,
          resolutions,
          repeat,
          devicePixelRatio: window.devicePixelRatio,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          maxTouchPoints: navigator.maxTouchPoints ?? null,
          screen: { width: screen.width, height: screen.height }
        };
      },
      { queries: STRING_QUERIES, ratios: [1, 1.25, 1.5, 2, 3] }
    );

    const r = observed.results;
    const anyError = Object.values(r).some((value) => typeof value !== 'boolean');
    const pointerFlags = [r['(pointer: fine)'], r['(pointer: coarse)'], r['(pointer: none)']];
    const anyPointer = [r['(any-pointer: fine)'], r['(any-pointer: coarse)']];

    rec.expect('mq/evaluated-without-error', !anyError, anyError ? r : undefined);
    rec.expect(
      'mq/pointer-exclusive',
      pointerFlags.filter((value) => value === true).length === 1,
      pointerFlags
    );
    rec.expect('mq/any-pointer-present', anyPointer.some((value) => value === true), anyPointer);
    if (r['(any-pointer: coarse)'] === true && typeof observed.maxTouchPoints === 'number') {
      rec.expect('mq/coarse-implies-touch', observed.maxTouchPoints > 0, {
        maxTouchPoints: observed.maxTouchPoints
      });
    } else {
      rec.unknown('mq/coarse-implies-touch', 'no coarse any-pointer on this context');
    }
    if (r['(hover: hover)'] === true) {
      rec.expect('mq/hover-implies-any-hover', r['(any-hover: hover)'] === true);
    } else {
      rec.unknown('mq/hover-implies-any-hover', 'primary pointer does not hover');
    }
    if (r['(color-gamut: p3)'] === true || r['(color-gamut: rec2020)'] === true) {
      rec.expect('mq/color-gamut-hierarchy', r['(color-gamut: srgb)'] === true, {
        srgb: r['(color-gamut: srgb)'],
        p3: r['(color-gamut: p3)'],
        rec2020: r['(color-gamut: rec2020)']
      });
    } else {
      rec.unknown('mq/color-gamut-hierarchy', 'wide-gamut query not matched');
    }
    rec.expect('mq/scripting-enabled', r['(scripting: enabled)'] === true);
    rec.expect('mq/display-mode-browser', r['(display-mode: browser)'] === true, {
      standalone: r['(display-mode: standalone)']
    });
    rec.expect(
      'mq/reduced-motion-declared',
      [r['(prefers-reduced-motion: no-preference)'], r['(prefers-reduced-motion: reduce)']].filter(
        (value) => value === true
      ).length === 1
    );
    rec.expect(
      'mq/contrast-declared',
      [r['(prefers-contrast: no-preference)'], r['(prefers-contrast: more)']].some((value) => value === true)
    );

    const dpr = observed.devicePixelRatio;
    const matching = Object.entries(observed.resolutions).filter(([, matched]) => matched === true);
    if (matching.length === 1 && Math.abs(Number(matching[0][0]) - dpr) < 0.001) {
      const others = Object.entries(observed.resolutions).filter(
        ([ratio, matched]) => matched === true && Number(ratio) !== Number(matching[0][0])
      );
      rec.expect('mq/resolution-matches-dpr', others.length === 0, { dpr, resolutions: observed.resolutions });
    } else if (matching.length === 0) {
      rec.unknown('mq/resolution-matches-dpr', { dpr, sampled: Object.keys(observed.resolutions) });
      rec.limit('dpr-not-sampled', `devicePixelRatio ${dpr} is outside the sampled set`);
    } else {
      rec.expect('mq/resolution-matches-dpr', false, { dpr, resolutions: observed.resolutions });
    }

    const expectsLandscape = observed.innerWidth >= observed.innerHeight;
    rec.expect(
      'mq/orientation-matches-viewport',
      r['(orientation: landscape)'] === expectsLandscape && r['(orientation: portrait)'] === !expectsLandscape,
      { innerWidth: observed.innerWidth, innerHeight: observed.innerHeight }
    );

    rec.expect(
      'mq/evaluation-deterministic',
      JSON.stringify(observed.results) === JSON.stringify(observed.repeat),
      'second evaluation differs'
    );

    return finish(rec, { queries: observed.results, resolutions: observed.resolutions, devicePixelRatio: dpr });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
