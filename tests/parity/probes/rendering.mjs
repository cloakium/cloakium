// Rendering parity probes: canvas readback noise, encode paths, offscreen
// canvases and origin scoping of the noise seed.

import { DRAW, FLAT_ANALYSIS, FNV, invariant, openPage } from './rendering-support.mjs';

const canvas2dNoise = {
  name: "rendering/canvas2d-noise",
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(
      async ({ drawSource, analyseSource, fnvSource }) => {
        const draw = eval(drawSource);
        const analyse = eval(analyseSource);
        const fnv = eval(fnvSource);
        const base = [0x33, 0x66, 0x99];

        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        const ctx = draw(canvas);
        const first = ctx.getImageData(0, 0, 64, 64);
        const repeat = ctx.getImageData(0, 0, 64, 64);

        const twin = document.createElement("canvas");
        twin.width = 64;
        twin.height = 64;
        const twinCtx = draw(twin);
        const twinData = twinCtx.getImageData(0, 0, 64, 64);

        const flat = analyse(first.data, 64, 50, 0, 14, 8, base, 1);
        const flatRepeat = analyse(repeat.data, 64, 50, 0, 14, 8, base, 1);

        // Round-trip: writing the (noisy) readback into a clean canvas and
        // reading it back must stay a bounded, deterministic perturbation.
        const echo = document.createElement("canvas");
        echo.width = 64;
        echo.height = 64;
        const echoCtx = echo.getContext("2d");
        echoCtx.putImageData(first, 0, 0);
        const echoData = echoCtx.getImageData(0, 0, 64, 64);
        const echoFlat = analyse(echoData.data, 64, 50, 0, 14, 8, base, 2);

        return {
          digest: fnv(new Uint8Array(first.data.buffer)),
          repeatDigest: fnv(new Uint8Array(repeat.data.buffer)),
          twinDigest: fnv(new Uint8Array(twinData.data.buffer)),
          echoDigest: fnv(new Uint8Array(echoData.data.buffer)),
          flat,
          flatRepeatEqual: JSON.stringify(flat) === JSON.stringify(flatRepeat),
          echoFlat,
          echoBounded: echoFlat.outOfRange === 0,
          pixel: Array.from(first.data.slice((60 * 64 + 40) * 4, (60 * 64 + 40) * 4 + 4)),
          size: [first.width, first.height],
          antialiasSample: Array.from(first.data.slice((40 * 64 + 40) * 4, (40 * 64 + 40) * 4 + 4)),
        };
      },
      { drawSource: DRAW, analyseSource: FLAT_ANALYSIS, fnvSource: FNV },
    );
    return invariant(observed, [
      ["size64", observed.size[0] === 64 && observed.size[1] === 64],
      ["flatAlphaUntouched", observed.flat.alphaChanged === 0],
      ["flatNoiseBoundedToOneBit", observed.flat.outOfRange === 0],
      ["flatNoiseActuallyApplied", observed.flat.changed > 0],
      ["readbackDeterministic", observed.repeatDigest === observed.digest],
      ["sameOriginTwinIdentical", observed.twinDigest === observed.digest],
      ["analyseDeterministic", observed.flatRepeatEqual],
      ["putImageDataRoundTripBounded", observed.echoBounded],
    ]);
  },
};

const canvasEncode = {
  name: "rendering/canvas2d-encode",
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(
      async ({ drawSource, fnvSource }) => {
        const draw = eval(drawSource);
        const fnv = eval(fnvSource);
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        draw(canvas);
        const url = canvas.toDataURL("image/png");
        const urlRepeat = canvas.toDataURL("image/png");
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const blobBytes = new Uint8Array(await blob.arrayBuffer());
        const decode = document.createElement("canvas");
        decode.width = 64;
        decode.height = 64;
        const decodeCtx = decode.getContext("2d");
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", () => reject(new Error("png decode failed")), { once: true });
          image.src = url;
        });
        decodeCtx.drawImage(image, 0, 0);
        const decoded = decodeCtx.getImageData(0, 0, 64, 64);
        const base64 = url.slice("data:image/png;base64,".length);
        const rawBytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        return {
          prefix: url.slice(0, "data:image/png;base64,".length),
          urlDigest: fnv(new TextEncoder().encode(url)),
          urlRepeatDigest: fnv(new TextEncoder().encode(urlRepeat)),
          blobDigest: fnv(blobBytes),
          blobType: blob.type,
          blobSize: blobBytes.length,
          rawPngDigest: fnv(rawBytes),
          pngSignature: Array.from(rawBytes.slice(0, 8)),
          decodedDigest: fnv(new Uint8Array(decoded.data.buffer)),
          decodedPixel: Array.from(decoded.data.slice(0, 4)),
          sameUrlAndBlob: fnv(new TextEncoder().encode(url)) === fnv(blobBytes),
        };
      },
      { drawSource: DRAW, fnvSource: FNV },
    );
    return invariant(observed, [
      ["pngPrefix", observed.prefix === "data:image/png;base64,"],
      ["pngSignature", JSON.stringify(observed.pngSignature) === JSON.stringify([137, 80, 78, 71, 13, 10, 26, 10])],
      ["encodeDeterministic", observed.urlDigest === observed.urlRepeatDigest],
      ["blobTyped", observed.blobType === "image/png"],
      ["blobNonEmpty", observed.blobSize > 100],
      ["decodedNonEmpty", observed.decodedDigest.length === 16],
    ]);
  },
};

const offscreenCanvas = {
  name: "rendering/offscreen-canvas",
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(
      async ({ drawSource, analyseSource, fnvSource }) => {
        const draw = eval(drawSource);
        const analyse = eval(analyseSource);
        const fnv = eval(fnvSource);
        const base = [0x33, 0x66, 0x99];

        const main = document.createElement("canvas");
        main.width = 64;
        main.height = 64;
        main.style.display = "none";
        document.body.append(main);
        draw(main);

        const offscreen = new OffscreenCanvas(64, 64);
        const offscreenCtx = draw(offscreen);
        const offscreenData = offscreenCtx.getImageData(0, 0, 64, 64);
        const offscreenRepeat = offscreenCtx.getImageData(0, 0, 64, 64);
        const blob = await offscreen.convertToBlob({ type: "image/png" });
        const blobBytes = new Uint8Array(await blob.arrayBuffer());

        const workerSource = `
          self.onmessage = () => {
            const canvas = new OffscreenCanvas(64, 64);
            const ctx = (${drawSource})(canvas);
            const data = ctx.getImageData(0, 0, 64, 64);
            const bytes = new Uint8Array(data.data.buffer);
            let a = 0x811c9dc5, b = 0x811c9dc5;
            for (let i = 0; i < bytes.length; i++) {
              a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
              b = Math.imul(b ^ ((bytes[i] + 0x9e) & 0xff), 0x85ebca6b) >>> 0;
            }
            postMessage({
              digest: a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"),
              pixels: Array.from(bytes.slice((60 * 64 + 40) * 4, (60 * 64 + 40) * 4 + 4)),
            });
          };
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
        const workerResult = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("offscreen worker timeout")), 8000);
          worker.addEventListener("message", (event) => {
            clearTimeout(timer);
            resolve(event.data);
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timer);
            reject(new Error(`offscreen worker error: ${event.message}`));
          });
          worker.postMessage("render");
        });
        worker.terminate();

        return {
          mainDigest: fnv(new Uint8Array(draw(main).getImageData(0, 0, 64, 64).data.buffer)),
          digest: fnv(new Uint8Array(offscreenData.data.buffer)),
          repeatDigest: fnv(new Uint8Array(offscreenRepeat.data.buffer)),
          flat: analyse(offscreenData.data, 64, 50, 0, 14, 8, base, 1),
          blobDigest: fnv(blobBytes),
          blobType: blob.type,
          blobSize: blobBytes.length,
          workerDigest: workerResult.digest,
          workerPixel: workerResult.pixels,
        };
      },
      { drawSource: DRAW, analyseSource: FLAT_ANALYSIS, fnvSource: FNV },
    );
    return invariant(observed, [
      ["offscreenDeterministic", observed.digest === observed.repeatDigest],
      ["offscreenNoiseBounded", observed.flat.outOfRange === 0],
      ["offscreenNoiseApplied", observed.flat.changed > 0],
      ["offscreenBlobTyped", observed.blobType === "image/png"],
      ["offscreenBlobNonEmpty", observed.blobSize > 100],
      ["workerMatchesMainThread", observed.workerDigest === observed.digest],
    ]);
  },
};

const canvasOriginScope = {
  name: "rendering/canvas2d-origin-scope",
  async run({ context, origin, crossOrigin }) {
    const read = async (base) => {
      const page = await openPage(context, base);
      const digest = await page.evaluate(({ drawSource, fnvSource }) => {
        const draw = eval(drawSource);
        const fnv = eval(fnvSource);
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        document.body.append(canvas);
        const ctx = draw(canvas);
        return fnv(new Uint8Array(ctx.getImageData(0, 0, 64, 64).data.buffer));
      }, { drawSource: DRAW, fnvSource: FNV });
      await page.close();
      return digest;
    };
    const primary = await read(origin);
    const primaryRepeat = await read(origin);
    const secondary = await read(crossOrigin);
    const observed = { origin, crossOrigin, primary, primaryRepeat, secondary };
    return invariant(observed, [
      ["sameOriginRepeatable", primary === primaryRepeat],
      ["crossOriginDiffers", primary !== secondary],
    ]);
  },
};


export const probes = [canvas2dNoise, canvasEncode, offscreenCanvas, canvasOriginScope];
