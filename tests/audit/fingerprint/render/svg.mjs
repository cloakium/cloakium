// SVG rasterisation through an <img> (blob: and data: variants).
//
// Exercises the SVG image decoder and the canvas drawImage path with a local,
// self-contained document: shapes, text and a Gaussian filter. No external
// references, no remote fonts.

import { HASH_SRC } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const SIZE = 64;

const probe = {
  id: 'svg-raster',
  family: 'render',
  budgetMs: 15_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'SVG is a local Blob/data URL; the only font is the generic sans-serif family.',
    checks: [
      'svg/blob-loads',
      'svg/raster-deterministic',
      'svg/colour-sensitive',
      'svg/text-rasterises',
      'svg/filter-applied',
      'svg/data-url-parity'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async (input) => {
      const hash = eval(input.hash);
      const size = input.size;
      const svg = (fill, text, blur) =>
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        size +
        '" height="' +
        size +
        '" viewBox="0 0 ' +
        size +
        ' ' +
        size +
        '">' +
        '<defs><filter id="b"><feGaussianBlur stdDeviation="' +
        (blur ? 2 : 0) +
        '"/></filter></defs>' +
        '<rect width="' +
        size +
        '" height="' +
        size +
        '" fill="#ffffff"/>' +
        '<g filter="url(#b)">' +
        '<circle cx="24" cy="24" r="14" fill="' +
        fill +
        '"/>' +
        '<rect x="30" y="30" width="26" height="20" fill="#204060" opacity="0.6"/>' +
        '</g>' +
        (text ? '<text x="4" y="58" font-family="sans-serif" font-size="12" fill="#000000">probe</text>' : '') +
        '</svg>';

      const raster = async (markup, via) => {
        const target = document.createElement('canvas');
        target.width = size;
        target.height = size;
        const ctx = target.getContext('2d');
        const image = new Image();
        const url =
          via === 'data'
            ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
            : URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
        try {
          await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', () => reject(new Error('svg decode failed')), { once: true });
            image.src = url;
          });
          await image.decode?.().catch(() => undefined);
          ctx.drawImage(image, 0, 0, size, size);
          return { digest: hash(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer)), width: image.naturalWidth, height: image.naturalHeight };
        } finally {
          if (via !== 'data') URL.revokeObjectURL(url);
        }
      };

      const base = svg('#cc3300', true, false);
      let blobResult = null;
      let blobError = null;
      try {
        blobResult = { first: await raster(base, 'blob'), second: await raster(base, 'blob') };
      } catch (error) {
        blobError = error.message;
      }
      let dataResult = null;
      let dataError = null;
      try {
        dataResult = await raster(base, 'data');
      } catch (error) {
        dataError = error.message;
      }
      let variants = null;
      let variantError = null;
      if (blobResult) {
        try {
          variants = {
            recoloured: (await raster(svg('#0066cc', true, false), 'blob')).digest,
            plain: (await raster(svg('#cc3300', false, false), 'blob')).digest,
            unblurred: (await raster(svg('#cc3300', true, true), 'blob')).digest
          };
        } catch (error) {
          variantError = error.message;
        }
      }
      return { blobResult, blobError, dataResult, dataError, variants, variantError };
    }, { hash: HASH_SRC, size: SIZE });

    if (!observed.blobResult) {
      rec.unknown('svg/blob-loads', observed.blobError);
      for (const name of [
        'svg/raster-deterministic',
        'svg/colour-sensitive',
        'svg/text-rasterises',
        'svg/filter-applied',
        'svg/data-url-parity'
      ]) {
        rec.unknown(name, observed.blobError);
      }
      rec.limit('svg-decode-unavailable', observed.blobError ?? 'SVG image decode failed');
      return finish(rec, observed);
    }

    rec.expect(
      'svg/blob-loads',
      observed.blobResult.first.width === SIZE && observed.blobResult.first.height === SIZE,
      observed.blobResult.first
    );
    rec.expect('svg/raster-deterministic', observed.blobResult.first.digest === observed.blobResult.second.digest);

    if (!observed.variants) {
      for (const name of ['svg/colour-sensitive', 'svg/text-rasterises', 'svg/filter-applied']) {
        rec.unknown(name, observed.variantError);
      }
      rec.limit('svg-variant-render-failed', observed.variantError);
    } else {
      rec.expect('svg/colour-sensitive', observed.variants.recoloured !== observed.blobResult.first.digest);
      rec.expect('svg/text-rasterises', observed.variants.plain !== observed.blobResult.first.digest);
      rec.expect('svg/filter-applied', observed.variants.unblurred !== observed.blobResult.first.digest);
    }

    if (observed.dataResult) {
      rec.expect('svg/data-url-parity', observed.dataResult.digest === observed.blobResult.first.digest, {
        data: observed.dataResult.digest,
        blob: observed.blobResult.first.digest
      });
    } else {
      rec.unknown('svg/data-url-parity', observed.dataError);
    }

    return finish(rec, {
      digests: {
        blob: observed.blobResult.first.digest,
        blobRepeat: observed.blobResult.second.digest,
        data: observed.dataResult?.digest ?? null,
        ...(observed.variants ?? {})
      },
      naturalSize: observed.blobResult.first
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
