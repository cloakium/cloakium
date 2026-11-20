// Canvas 2D readback: determinism, non-cumulative perturbation, boundedness,
// alpha preservation and encode/decode consistency.

import { FLAT_REGION, FLAT_SRC, DRAW_SRC, HASH_SRC, PROBE_SIZE } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const BASE_FILL = [0x33, 0x66, 0x99];

const probe = {
  id: 'canvas2d-readback',
  family: 'render',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Compares pixel digests across repeated reads and encode paths; never asserts a specific pixel value.',
    checks: [
      'canvas2d/context-available',
      'canvas2d/size-preserved',
      'canvas2d/readback-deterministic',
      'canvas2d/flat-deviation-bounded',
      'canvas2d/alpha-untouched',
      'canvas2d/echo-stable',
      'canvas2d/echo-bounded',
      'canvas2d/encode-deterministic',
      'canvas2d/png-signature',
      'canvas2d/blob-nonempty',
      'canvas2d/decode-deterministic',
      'canvas2d/context-mode-parity'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async (input) => {
        const draw = eval(input.draw);
        const analyse = eval(input.flat);
        const hash = eval(input.hash);
        const size = input.size;
        const region = input.region;
        const base = input.base;
        const bound = 2;

        const make = (readFrequently) => {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          if (!readFrequently) document.body.append(canvas);
          draw(canvas, { readFrequently });
          return canvas;
        };
        const digestOf = (imageData) => hash(new Uint8Array(imageData.data.buffer));

        const canvas = make(false);
        const ctx = canvas.getContext('2d');
        const reads = [1, 2, 3].map(() => {
          const data = ctx.getImageData(0, 0, size, size);
          return { digest: digestOf(data), data };
        });
        const first = reads[0].data;
        const flat = analyse(first.data, size, region.x0, region.y0, region.w, region.h, base, bound);

        const echoOne = document.createElement('canvas');
        echoOne.width = size;
        echoOne.height = size;
        const echoOneCtx = echoOne.getContext('2d');
        echoOneCtx.putImageData(first, 0, 0);
        const echoData = echoOneCtx.getImageData(0, 0, size, size);

        const echoTwo = document.createElement('canvas');
        echoTwo.width = size;
        echoTwo.height = size;
        const echoTwoCtx = echoTwo.getContext('2d');
        echoTwoCtx.putImageData(echoData, 0, 0);
        const echoTwoData = echoTwoCtx.getImageData(0, 0, size, size);

        const url = canvas.toDataURL('image/png');
        const urlRepeat = canvas.toDataURL('image/png');
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const blobBytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
        const raw = Uint8Array.from(atob(url.slice('data:image/png;base64,'.length)), (character) =>
          character.charCodeAt(0)
        );

        const decode = async () => {
          const target = document.createElement('canvas');
          target.width = size;
          target.height = size;
          const targetCtx = target.getContext('2d');
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', () => reject(new Error('png decode failed')), { once: true });
            image.src = url;
          });
          await image.decode?.().catch(() => undefined);
          targetCtx.drawImage(image, 0, 0);
          return digestOf(targetCtx.getImageData(0, 0, size, size));
        };
        let decoded = null;
        let decodeError = null;
        try {
          decoded = { first: await decode(), second: await decode() };
        } catch (error) {
          decodeError = error.message;
        }

        const frequent = make(true);
        const frequentDigest = digestOf(frequent.getContext('2d').getImageData(0, 0, size, size));

        return {
          size: [first.width, first.height],
          reads: reads.map((entry) => entry.digest),
          flat,
          echo: {
            digest: digestOf(echoData),
            repeatDigest: digestOf(echoTwoData),
            delta: analyse(echoData.data, size, region.x0, region.y0, region.w, region.h, base, bound)
          },
          encode: {
            url,
            urlRepeat,
            urlDigest: hash(new TextEncoder().encode(url)),
            urlRepeatDigest: hash(new TextEncoder().encode(urlRepeat)),
            blobDigest: hash(blobBytes),
            blobType: blob?.type ?? null,
            blobSize: blobBytes.length,
            pngSignature: Array.from(raw.slice(0, 8))
          },
          decoded,
          decodeError,
          frequentDigest,
          contextAttributesDefault: ctx.getContextAttributes?.() ?? null,
          contextAttributesFrequent: frequent.getContext('2d').getContextAttributes?.() ?? null
        };
      },
      { draw: DRAW_SRC, flat: FLAT_SRC, hash: HASH_SRC, size: PROBE_SIZE, region: FLAT_REGION, base: BASE_FILL }
    );

    rec.expect('canvas2d/context-available', observed.size[0] === PROBE_SIZE && observed.size[1] === PROBE_SIZE);
    rec.expect('canvas2d/size-preserved', observed.size[0] === PROBE_SIZE && observed.size[1] === PROBE_SIZE, {
      size: observed.size
    });
    rec.expect(
      'canvas2d/readback-deterministic',
      observed.reads[0] === observed.reads[1] && observed.reads[1] === observed.reads[2],
      observed.reads
    );
    rec.expect(
      'canvas2d/flat-deviation-bounded',
      observed.flat.outOfRange === 0 && observed.flat.maxAbsDelta <= 2,
      { outOfRange: observed.flat.outOfRange, maxAbsDelta: observed.flat.maxAbsDelta }
    );
    rec.expect('canvas2d/alpha-untouched', observed.flat.alphaChanged === 0, observed.flat.alphaChanged);
    rec.expect(
      'canvas2d/echo-stable',
      observed.echo.digest === observed.echo.repeatDigest,
      { first: observed.echo.digest, second: observed.echo.repeatDigest }
    );
    rec.expect(
      'canvas2d/echo-bounded',
      observed.echo.delta.outOfRange === 0 && observed.echo.delta.maxAbsDelta <= 4,
      { maxAbsDelta: observed.echo.delta.maxAbsDelta, samples: observed.echo.delta.samples }
    );
    rec.expect('canvas2d/encode-deterministic', observed.encode.urlDigest === observed.encode.urlRepeatDigest);
    rec.expect(
      'canvas2d/png-signature',
      JSON.stringify(observed.encode.pngSignature) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10])
    );
    rec.expect(
      'canvas2d/blob-nonempty',
      observed.encode.blobType === 'image/png' && observed.encode.blobSize > 100,
      { type: observed.encode.blobType, size: observed.encode.blobSize }
    );
    if (observed.decoded === null) {
      rec.unknown('canvas2d/decode-deterministic', observed.decodeError);
      rec.limit('png-decode-unavailable', observed.decodeError);
    } else {
      rec.expect('canvas2d/decode-deterministic', observed.decoded.first === observed.decoded.second);
    }
    rec.expect(
      'canvas2d/context-mode-parity',
      observed.frequentDigest === observed.reads[0],
      { defaultDigest: observed.reads[0], willReadFrequentlyDigest: observed.frequentDigest }
    );

    const { url, urlRepeat, ...encode } = observed.encode;
    return finish(rec, {
      size: observed.size,
      digests: observed.reads,
      flat: observed.flat,
      echo: observed.echo,
      encode,
      decoded: observed.decoded,
      contextAttributesDefault: observed.contextAttributesDefault,
      urlPrefix: url.slice(0, 'data:image/png;base64,'.length),
      urlStable: url === urlRepeat
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
