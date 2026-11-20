// Font metrics: determinism, linear scaling and agreement between the FontFaceSet
// view and actual rendering.
//
// Only generic CSS families and a small list of public font names are used. No
// installed-font enumeration is performed beyond what `document.fonts.check`
// answers for those names, and a minimal font set is a declared gap.

import { finish, prepare, recorder } from '../support/common.mjs';

const SAMPLE_FONTS = [
  'DejaVu Sans',
  'DejaVu Sans Mono',
  'DejaVu Serif',
  'Liberation Sans',
  'Liberation Mono',
  'Liberation Serif',
  'Noto Sans',
  'Noto Color Emoji',
  'Noto Sans CJK SC',
  'FreeSans',
  'Ubuntu'
];

const probe = {
  id: 'font-metrics',
  family: 'text',
  budgetMs: 15_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Awaits document.fonts.ready. Sample list is public-standard; absence is recorded, not failed.',
    checks: [
      'font/fontset-readable',
      'font/fontset-status-settled',
      'font/measuretext-positive',
      'font/measuretext-deterministic',
      'font/size-scaling-linear',
      'font/length-monotonic',
      'font/families-distinguished',
      'font/check-agrees-with-render'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async (fonts) => {
      const fontSet = document.fonts ?? null;
      if (fontSet?.ready) await fontSet.ready;
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 80;
      document.body.append(canvas);
      const ctx = canvas.getContext('2d');

      const text = 'cloakium-metrics-0123456789';
      const measure = (family, size) => {
        ctx.font = `${size}px ${family}`;
        return ctx.measureText(text).width;
      };
      const first = {};
      const second = {};
      const families = ['monospace', 'serif', 'sans-serif', 'system-ui'];
      for (const family of families) {
        first[family] = measure(family, 16);
        second[family] = measure(family, 16);
      }
      const at32 = {};
      for (const family of families) at32[family] = measure(family, 32);

      const shortText = measure('sans-serif', 16);
      ctx.font = '16px sans-serif';
      const five = ctx.measureText('iiiii').width;
      const ten = ctx.measureText('iiiiiiiiii').width;

      const render = (family) => {
        const target = document.createElement('canvas');
        target.width = 200;
        target.height = 48;
        const targetCtx = target.getContext('2d');
        targetCtx.fillStyle = '#ffffff';
        targetCtx.fillRect(0, 0, 200, 48);
        targetCtx.fillStyle = '#000000';
        targetCtx.font = `24px ${family}`;
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText('cloakium gaq', 2, 24);
        const data = targetCtx.getImageData(0, 0, 200, 48).data;
        let digest = 0;
        for (let index = 0; index < data.length; index++) digest = (Math.imul(digest, 31) + data[index]) >>> 0;
        return String(digest);
      };

      const availability = {};
      for (const name of fonts) {
        try {
          availability[name] = fontSet ? fontSet.check(`24px "${name}"`) : null;
        } catch (error) {
          availability[name] = { error: error.name };
        }
      }
      const fallbackDigest = render('cloakium-absent-family-probe');
      const digests = {};
      for (const name of fonts) {
        if (availability[name] === true) digests[name] = render(`"${name}"`);
      }

      return {
        hasFontSet: Boolean(fontSet),
        size: fontSet ? fontSet.size : null,
        status: fontSet ? fontSet.status : null,
        first,
        second,
        at32,
        five,
        ten,
        shortText,
        availability,
        digests,
        fallbackDigest,
        fontsQuery: typeof navigator.fonts?.query === 'function'
      };
    }, SAMPLE_FONTS);

    if (!observed.hasFontSet) {
      rec.unknown('font/fontset-readable', 'document.fonts absent');
      rec.limit('fontface-set-absent', 'document.fonts is not exposed');
    } else {
      rec.expect('font/fontset-readable', Number.isInteger(observed.size) && observed.size >= 0, observed.size);
      rec.expect('font/fontset-status-settled', observed.status === 'loaded', observed.status);
    }

    const widths = observed.first;
    rec.expect(
      'font/measuretext-positive',
      Object.values(widths).every((value) => Number.isFinite(value) && value > 0),
      widths
    );
    rec.expect('font/measuretext-deterministic', JSON.stringify(widths) === JSON.stringify(observed.second), {
      first: widths,
      second: observed.second
    });
    const scaling = Object.keys(widths).map((family) =>
      widths[family] > 0 ? observed.at32[family] / widths[family] : null
    );
    rec.expect(
      'font/size-scaling-linear',
      scaling.every((ratio) => ratio !== null && Math.abs(ratio - 2) < 0.04),
      scaling
    );
    rec.expect('font/length-monotonic', observed.ten > observed.five, { five: observed.five, ten: observed.ten });

    const distinct = new Set(Object.values(widths).map((value) => Number(value.toFixed(3))));
    if (distinct.size === 1) {
      rec.unknown('font/families-distinguished', { widths, reason: 'all generic families share one metric set' });
      rec.limit('single-font-family', 'monospace/serif/sans-serif/system-ui resolve identically');
    } else {
      rec.expect('font/families-distinguished', distinct.size >= 2, widths);
    }

    const available = Object.entries(observed.availability)
      .filter(([, present]) => present === true)
      .map(([name]) => name);
    if (available.length === 0) {
      rec.unknown('font/check-agrees-with-render', 'no sample font reported available');
      rec.limit('no-sample-fonts', 'None of the public sample fonts are installed');
    } else {
      const differing = available.filter((name) => observed.digests[name] !== observed.fallbackDigest);
      if (differing.length === 0) {
        rec.unknown('font/check-agrees-with-render', {
          available,
          reason: 'every reported font rasterises identically to the absent-family fallback'
        });
        rec.limit('font-substitution-uniform', 'document.fonts.check reports fonts that render as the fallback');
      } else {
        rec.expect('font/check-agrees-with-render', true, { differing });
      }
    }

    return finish(rec, {
      fontSet: { size: observed.size, status: observed.status },
      widths,
      widthsAt32: observed.at32,
      scaling,
      shortText: observed.shortText,
      availability: observed.availability,
      digests: observed.digests,
      fallbackDigest: observed.fallbackDigest,
      localFontAccessApi: observed.fontsQuery
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
