// Canvas text: metrics determinism, family distinctness, and glyph rasterisation
// for Latin, CJK and emoji sample strings.
//
// A glyph is only reported as present when its bitmap differs from the context's
// own fallback box (a private-use codepoint), so a minimal font set is recorded
// as a coverage gap rather than a failure or a false pass.

import { HASH_SRC } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'canvas2d-text',
  family: 'render',
  budgetMs: 15_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Uses generic CSS families and one public sample per script; never enumerates installed fonts.',
    checks: [
      'text/measuretext-finite',
      'text/measuretext-deterministic',
      'text/metrics-ascent-positive',
      'text/families-distinguished',
      'text/raster-deterministic',
      'text/raster-distinguishes-strings',
      'text/emoji-glyph-present',
      'text/cjk-glyph-present'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async (hashSource) => {
      const hash = eval(hashSource);
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 72;
      document.body.append(canvas);
      const ctx = canvas.getContext('2d');

      const families = ['monospace', 'serif', 'sans-serif', 'system-ui'];
      const measure = () => {
        const widths = {};
        const metrics = {};
        for (const family of families) {
          ctx.font = `16px ${family}`;
          const value = ctx.measureText('cloakium probe 0123');
          widths[family] = value.width;
          metrics[family] = {
            ascent: value.actualBoundingBoxAscent ?? null,
            descent: value.actualBoundingBoxDescent ?? null,
            left: value.actualBoundingBoxLeft ?? null,
            right: value.actualBoundingBoxRight ?? null,
            fontAscent: value.fontBoundingBoxAscent ?? null,
            fontDescent: value.fontBoundingBoxDescent ?? null
          };
        }
        return { widths, metrics };
      };
      const first = measure();
      const second = measure();

      const render = (text, family) => {
        const target = document.createElement('canvas');
        target.width = 160;
        target.height = 72;
        const targetCtx = target.getContext('2d');
        targetCtx.fillStyle = '#ffffff';
        targetCtx.fillRect(0, 0, target.width, target.height);
        targetCtx.fillStyle = '#000000';
        targetCtx.font = `32px ${family}`;
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText(text, 4, 36);
        return hash(new Uint8Array(targetCtx.getImageData(0, 0, 160, 72).data.buffer));
      };

      const ascii = render('Cloakium', 'sans-serif');
      const asciiRepeat = render('Cloakium', 'sans-serif');
      const asciiOther = render('Cloakium!', 'sans-serif');
      const fallback = render('\u{FFFF}\u{FFFF}', 'sans-serif');
      const emoji = render('\u{1F600}\u{1F9EA}', 'sans-serif');
      const cjk = render('\u8AD6\u7406', 'sans-serif');

      return {
        first,
        second,
        repeatStable: JSON.stringify(first) === JSON.stringify(second),
        ascii,
        asciiRepeat,
        asciiOther,
        fallback,
        emoji,
        cjk,
        fontKerning: 'fontKerning' in ctx,
        fontStretch: 'fontStretch' in ctx,
        letterSpacing: 'letterSpacing' in ctx
      };
    }, HASH_SRC);

    const widths = observed.first.widths;
    const metrics = observed.first.metrics;
    const widthsFinite = Object.values(widths).every((value) => Number.isFinite(value) && value > 0);

    rec.expect('text/measuretext-finite', widthsFinite, widths);
    rec.expect('text/measuretext-deterministic', observed.repeatStable, {
      first: widths,
      second: observed.second.widths
    });
    rec.expect(
      'text/metrics-ascent-positive',
      Object.values(metrics).every(
        (entry) => entry.ascent === null || (Number.isFinite(entry.ascent) && entry.ascent > 0)
      ),
      metrics
    );

    const distinct = new Set(Object.values(widths).map((value) => Number(value.toFixed(3))));
    if (distinct.size === 1) {
      rec.unknown('text/families-distinguished', { widths, reason: 'all generic families resolve identically' });
      rec.limit('single-font-family', 'The host resolves monospace/serif/sans-serif/system-ui to one metric set');
    } else {
      rec.expect('text/families-distinguished', distinct.size >= 2, widths);
    }

    rec.expect('text/raster-deterministic', observed.ascii === observed.asciiRepeat, {
      first: observed.ascii,
      second: observed.asciiRepeat
    });
    rec.expect(
      'text/raster-distinguishes-strings',
      observed.ascii !== observed.asciiOther && observed.ascii !== observed.fallback,
      { ascii: observed.ascii, other: observed.asciiOther, fallback: observed.fallback }
    );

    if (observed.emoji === observed.fallback) {
      rec.unknown('text/emoji-glyph-present', { emoji: observed.emoji, fallback: observed.fallback });
      rec.limit('emoji-font-absent', 'Emoji sample renders as the fallback box');
    } else {
      rec.expect('text/emoji-glyph-present', true);
    }
    if (observed.cjk === observed.fallback) {
      rec.unknown('text/cjk-glyph-present', { cjk: observed.cjk, fallback: observed.fallback });
      rec.limit('cjk-font-absent', 'CJK sample renders as the fallback box');
    } else {
      rec.expect('text/cjk-glyph-present', true);
    }

    return finish(rec, {
      widths,
      metrics,
      repeatStable: observed.repeatStable,
      digests: {
        ascii: observed.ascii,
        asciiRepeat: observed.asciiRepeat,
        asciiOther: observed.asciiOther,
        fallback: observed.fallback,
        emoji: observed.emoji,
        cjk: observed.cjk
      },
      support: {
        fontKerning: observed.fontKerning,
        fontStretch: observed.fontStretch,
        letterSpacing: observed.letterSpacing
      }
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
