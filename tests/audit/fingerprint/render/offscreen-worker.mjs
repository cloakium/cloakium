// OffscreenCanvas and Blob-worker consistency.
//
// The same scene is rendered on a DOM canvas, on an OffscreenCanvas in the main
// thread, and inside a Blob worker. All three must agree: a per-thread or
// per-surface difference is a real coherence defect.

import { DRAW_SRC, HASH_SRC, PROBE_SIZE } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'offscreen-worker',
  family: 'render',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Worker is created from a local Blob URL only; no module or network fetch.',
    checks: [
      'offscreen/context-available',
      'offscreen/blob-encode',
      'offscreen/main-parity',
      'offscreen/worker-available',
      'offscreen/worker-parity',
      'offscreen/worker-repeatable',
      'offscreen/transfer-to-bitmap'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async (input) => {
        const draw = eval(input.draw);
        const hash = eval(input.hash);
        const size = input.size;
        const digestOf = (data) => hash(new Uint8Array(data.data.buffer));

        const dom = document.createElement('canvas');
        dom.width = size;
        dom.height = size;
        document.body.append(dom);
        draw(dom, {});
        const domDigest = digestOf(dom.getContext('2d').getImageData(0, 0, size, size));

        if (typeof OffscreenCanvas !== 'function') {
          return { domDigest, offscreen: null, worker: null, workerError: 'OffscreenCanvas absent' };
        }

        const offscreen = new OffscreenCanvas(size, size);
        const offscreenCtx = draw(offscreen, {});
        const offscreenDigest = digestOf(offscreenCtx.getImageData(0, 0, size, size));
        const offscreenRepeat = digestOf(offscreenCtx.getImageData(0, 0, size, size));

        let blob = null;
        let blobError = null;
        try {
          const encoded = await offscreen.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await encoded.arrayBuffer());
          const again = new Uint8Array(await (await offscreen.convertToBlob({ type: 'image/png' })).arrayBuffer());
          blob = {
            type: encoded.type,
            size: bytes.length,
            digest: hash(bytes),
            repeatDigest: hash(again),
            signature: Array.from(bytes.slice(0, 8))
          };
        } catch (error) {
          blobError = error.message;
        }

        let bitmap = null;
        try {
          if (typeof offscreen.transferToImageBitmap === 'function') {
            const image = offscreen.transferToImageBitmap();
            bitmap = { width: image.width, height: image.height };
            image.close?.();
          }
        } catch (error) {
          bitmap = { error: error.message };
        }

        let worker = null;
        let workerError = null;
        try {
          const source =
            'self.onmessage = () => {\n' +
            '  const draw = ' +
            input.draw +
            ';\n' +
            '  const hash = ' +
            input.hash +
            ';\n' +
            '  const canvas = new OffscreenCanvas(' +
            size +
            ', ' +
            size +
            ');\n' +
            '  const ctx = draw(canvas, {});\n' +
            '  const data = ctx.getImageData(0, 0, ' +
            size +
            ', ' +
            size +
            ');\n' +
            '  postMessage(hash(new Uint8Array(data.data.buffer)));\n' +
            '};\n';
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          const runOnce = () =>
            new Promise((resolve, reject) => {
              const instance = new Worker(url);
              const timer = setTimeout(() => {
                instance.terminate();
                reject(new Error('worker timeout'));
              }, 6000);
              instance.addEventListener('message', (event) => {
                clearTimeout(timer);
                instance.terminate();
                resolve(event.data);
              });
              instance.addEventListener('error', (event) => {
                clearTimeout(timer);
                instance.terminate();
                reject(new Error(event.message || 'worker error'));
              });
              instance.postMessage('render');
            });
          const firstRun = await runOnce();
          const secondRun = await runOnce();
          URL.revokeObjectURL(url);
          worker = { first: firstRun, second: secondRun };
        } catch (error) {
          workerError = error.message ?? String(error);
        }

        return {
          domDigest,
          offscreen: {
            digest: offscreenDigest,
            repeatDigest: offscreenRepeat,
            blob,
            blobError,
            bitmap
          },
          worker,
          workerError
        };
      },
      { draw: DRAW_SRC, hash: HASH_SRC, size: PROBE_SIZE }
    );

    if (!observed.offscreen) {
      rec.unknown('offscreen/context-available', 'OffscreenCanvas absent');
      rec.unknown('offscreen/blob-encode', 'OffscreenCanvas absent');
      rec.unknown('offscreen/main-parity', 'OffscreenCanvas absent');
      rec.limit('offscreen-canvas-absent', 'This context does not expose OffscreenCanvas');
    } else {
      rec.expect('offscreen/context-available', observed.offscreen.digest === observed.offscreen.repeatDigest);
      if (!observed.offscreen.blob) {
        rec.unknown('offscreen/blob-encode', observed.offscreen.blobError);
        rec.limit('offscreen-blob-unavailable', observed.offscreen.blobError);
      } else {
        rec.expect(
          'offscreen/blob-encode',
          observed.offscreen.blob.type === 'image/png' &&
            observed.offscreen.blob.size > 100 &&
            observed.offscreen.blob.digest === observed.offscreen.blob.repeatDigest &&
            JSON.stringify(observed.offscreen.blob.signature) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10]),
          { type: observed.offscreen.blob.type, size: observed.offscreen.blob.size }
        );
      }
      rec.expect('offscreen/main-parity', observed.offscreen.digest === observed.domDigest, {
        offscreen: observed.offscreen.digest,
        dom: observed.domDigest
      });
    }

    if (!observed.worker) {
      rec.unknown('offscreen/worker-available', observed.workerError);
      rec.unknown('offscreen/worker-parity', observed.workerError);
      rec.unknown('offscreen/worker-repeatable', observed.workerError);
      rec.limit('blob-worker-unavailable', observed.workerError ?? 'Worker could not be created');
    } else {
      rec.expect('offscreen/worker-available', true);
      rec.expect('offscreen/worker-parity', observed.worker.first === observed.domDigest, {
        worker: observed.worker.first,
        dom: observed.domDigest
      });
      rec.expect('offscreen/worker-repeatable', observed.worker.first === observed.worker.second);
    }

    if (observed.offscreen && observed.offscreen.bitmap) {
      if (observed.offscreen.bitmap.error) {
        rec.unknown('offscreen/transfer-to-bitmap', observed.offscreen.bitmap.error);
      } else {
        rec.expect(
          'offscreen/transfer-to-bitmap',
          observed.offscreen.bitmap.width === PROBE_SIZE && observed.offscreen.bitmap.height === PROBE_SIZE,
          observed.offscreen.bitmap
        );
      }
    } else {
      rec.unknown('offscreen/transfer-to-bitmap', 'transferToImageBitmap absent');
    }

    return finish(rec, {
      domDigest: observed.domDigest,
      offscreenDigest: observed.offscreen?.digest ?? null,
      offscreenRepeatDigest: observed.offscreen?.repeatDigest ?? null,
      blob: observed.offscreen?.blob ?? null,
      bitmap: observed.offscreen?.bitmap ?? null,
      worker: observed.worker,
      workerError: observed.workerError
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
