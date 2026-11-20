// CSS system colours as resolved by two independent paths: the canvas colour
// parser and computed style. A persona that changes OS colours must keep both
// paths and the contrast pairs coherent.

import { finish, prepare, recorder } from '../support/common.mjs';

const KEYWORDS = [
  'Canvas',
  'CanvasText',
  'ButtonFace',
  'ButtonText',
  'Field',
  'FieldText',
  'Highlight',
  'HighlightText',
  'GrayText',
  'LinkText',
  'AccentColor',
  'AccentColorText'
];

const probe = {
  id: 'system-colors',
  family: 'text',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Reads system colour keywords only; no theme media query is assumed.',
    checks: [
      'colors/keywords-resolved',
      'colors/deterministic',
      'colors/canvas-text-contrast',
      'colors/highlight-contrast',
      'colors/css-and-canvas-agree'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate((keywords) => {
      const resolve = (keyword) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#010203';
        ctx.fillStyle = keyword;
        const normalised = ctx.fillStyle;
        if (typeof normalised !== 'string' || normalised === '#010203') {
          return { supported: false, normalised: String(normalised) };
        }
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return { supported: true, normalised, rgba: [r, g, b, a] };
      };

      const parseRgb = (value) => {
        const match = /^rgba?\(([^)]+)\)$/.exec(String(value).trim());
        if (!match) return null;
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some((entry) => !Number.isFinite(entry))) return null;
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      };

      const computed = {};
      const host = document.createElement('div');
      document.body.append(host);
      for (const keyword of keywords) {
        const element = document.createElement('span');
        element.textContent = 'x';
        element.style.color = keyword;
        host.append(element);
        computed[keyword] = parseRgb(getComputedStyle(element).color);
        element.remove();
      }

      const first = {};
      const second = {};
      for (const keyword of keywords) first[keyword] = resolve(keyword);
      for (const keyword of keywords) second[keyword] = resolve(keyword);
      return { first, second, computed };
    }, KEYWORDS);

    const resolved = Object.entries(observed.first).filter(([, value]) => value.supported);
    const unsupported = Object.entries(observed.first)
      .filter(([, value]) => !value.supported)
      .map(([name]) => name);

    rec.expect('colors/keywords-resolved', resolved.length >= 8, { resolved: resolved.length, unsupported });
    if (resolved.length < 8) rec.limit('system-colors-partial', 'Canvas rejects several system colour keywords');
    rec.expect('colors/deterministic', JSON.stringify(observed.first) === JSON.stringify(observed.second));

    const canvasColour = observed.first.Canvas;
    const canvasText = observed.first.CanvasText;
    if (canvasColour?.supported && canvasText?.supported) {
      rec.expect(
        'colors/canvas-text-contrast',
        JSON.stringify(canvasColour.rgba.slice(0, 3)) !== JSON.stringify(canvasText.rgba.slice(0, 3)),
        { Canvas: canvasColour.rgba, CanvasText: canvasText.rgba }
      );
    } else {
      rec.unknown('colors/canvas-text-contrast', 'Canvas/CanvasText keywords not resolvable');
    }
    const highlight = observed.first.Highlight;
    const highlightText = observed.first.HighlightText;
    if (highlight?.supported && highlightText?.supported) {
      rec.expect(
        'colors/highlight-contrast',
        JSON.stringify(highlight.rgba.slice(0, 3)) !== JSON.stringify(highlightText.rgba.slice(0, 3)),
        { Highlight: highlight.rgba, HighlightText: highlightText.rgba }
      );
    } else {
      rec.unknown('colors/highlight-contrast', 'Highlight keywords not resolvable');
    }

    if (!canvasColour?.supported || !canvasText?.supported || !observed.computed.CanvasText) {
      rec.unknown('colors/css-and-canvas-agree', 'one resolution path unavailable');
    } else {
      const cssText = observed.computed.CanvasText;
      const cssCanvas = observed.computed.Canvas;
      rec.expect(
        'colors/css-and-canvas-agree',
        JSON.stringify([cssText[0], cssText[1], cssText[2]]) ===
          JSON.stringify(canvasText.rgba.slice(0, 3)) &&
          JSON.stringify([cssCanvas[0], cssCanvas[1], cssCanvas[2]]) ===
            JSON.stringify(canvasColour.rgba.slice(0, 3)),
        { css: { Canvas: cssCanvas, CanvasText: cssText } }
      );
    }

    return finish(rec, {
      canvas: observed.first,
      computed: observed.computed,
      unsupported
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
