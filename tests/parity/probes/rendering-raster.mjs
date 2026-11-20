// Rendering parity probes: SVG/bitmap rasterisation, real font metrics and
// media capability answers.

import { FNV, invariant, openPage } from './rendering-support.mjs';

const svgRaster = {
  name: "rendering/svg-and-images",
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(async (fnvSource) => {
      const fnv = eval(fnvSource);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
        <rect width="48" height="48" fill="#336699"/>
        <circle cx="24" cy="24" r="10" fill="#ff8800"/>
        <text x="4" y="44" font-family="monospace" font-size="8" fill="#ffffff">svg</text>
      </svg>`;
      const svgUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new Error("svg decode failed")), { once: true });
        image.src = svgUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 48;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const first = ctx.getImageData(0, 0, 48, 48);
      const repeat = ctx.getImageData(0, 0, 48, 48);
      const bitmap = await createImageBitmap(image);
      const bitmapCanvas = document.createElement("canvas");
      bitmapCanvas.width = 48;
      bitmapCanvas.height = 48;
      const bitmapCtx = bitmapCanvas.getContext("2d");
      bitmapCtx.drawImage(bitmap, 0, 0);
      const bitmapData = bitmapCtx.getImageData(0, 0, 48, 48);
      return {
        digest: fnv(new Uint8Array(first.data.buffer)),
        repeatDigest: fnv(new Uint8Array(repeat.data.buffer)),
        bitmapDigest: fnv(new Uint8Array(bitmapData.data.buffer)),
        corner: Array.from(first.data.slice(0, 4)),
        center: Array.from(first.data.slice((24 * 48 + 24) * 4, (24 * 48 + 24) * 4 + 4)),
        bitmapSize: [bitmap.width, bitmap.height],
      };
    }, FNV);
    return invariant(observed, [
      ["deterministic", observed.digest === observed.repeatDigest],
      ["bitmapSizeCorrect", observed.bitmapSize[0] === 48 && observed.bitmapSize[1] === 48],
      ["cornerNearFill", Math.abs(observed.corner[0] - 0x33) <= 1 && Math.abs(observed.corner[2] - 0x99) <= 1],
    ]);
  },
};

const textMetrics = {
  name: "rendering/text-font-metrics",
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const families = ["monospace", "serif", "sans-serif", "system-ui", "DejaVu Sans", "Liberation Sans", "Noto Sans"];
      const measure = (font, text) => {
        ctx.font = font;
        const metrics = ctx.measureText(text);
        return {
          width: Number(metrics.width.toFixed(4)),
          ascent: Number((metrics.actualBoundingBoxAscent ?? 0).toFixed(4)),
          descent: Number((metrics.actualBoundingBoxDescent ?? 0).toFixed(4)),
          left: Number((metrics.actualBoundingBoxLeft ?? 0).toFixed(4)),
          right: Number((metrics.actualBoundingBoxRight ?? 0).toFixed(4)),
          fontAscent: Number((metrics.fontBoundingBoxAscent ?? 0).toFixed(4)),
          fontDescent: Number((metrics.fontBoundingBoxDescent ?? 0).toFixed(4)),
        };
      };
      const widths = {};
      for (const family of families) {
        ctx.font = `16px "${family}", monospace`;
        widths[family] = {
          ascii: measure(`16px "${family}", monospace`, "The quick brown fox 0123456789"),
          cjk: measure(`16px "${family}", monospace`, "\u4f60\u597d\u4e16\u754c"),
          emoji: measure(`16px "${family}", monospace`, "\ud83d\ude00"),
          canvasWidth: Number(ctx.measureText("The quick brown fox 0123456789").width.toFixed(4)),
        };
      }
      const repeat = ctx.measureText("The quick brown fox 0123456789").width;
      return {
        widths,
        deterministic: Number(repeat.toFixed(4)) === widths["Noto Sans"].ascii.width,
        fontChecks: families.map((family) => ({ family, check: document.fonts.check(`16px "${family}"`) })),
        defaults: { font: ctx.font, textAlign: ctx.textAlign, direction: ctx.direction },
        letterSpacingSupported: "letterSpacing" in ctx,
        fontStretchSupported: "fontStretch" in ctx,
      };
    });
    const asciiWidths = Object.fromEntries(Object.entries(observed.widths).map(([family, value]) => [family, value.ascii.width]));
    const distinctWidths = new Set(Object.values(asciiWidths));
    return invariant(observed, [
      ["deterministicMetrics", observed.deterministic],
      ["allWidthsPositive", Object.values(asciiWidths).every((width) => width > 0)],
      ["monospaceDiffersFromSerif", observed.widths.monospace.ascii.width !== observed.widths.serif.ascii.width],
      ["fallbackChainStable", distinctWidths.size >= 2],
      ["cjkMeasured", Object.values(observed.widths).every((value) => value.cjk.width > 0)],
    ]);
  },
};

const mediaCodecs = {
  name: "rendering/media-codecs",
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(async () => {
      const types = [
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="av01.0.05M.08"',
        'video/webm; codecs="vp8"',
        'video/webm; codecs="vp9"',
        'audio/mp4; codecs="mp4a.40.2"',
        'audio/webm; codecs="opus"',
        'audio/ogg; codecs="vorbis"',
        'audio/flac',
        'audio/wav; codecs="1"',
        "image/png",
        "image/webp",
        "image/avif",
        "image/jpeg",
      ];
      const element = document.createElement("video");
      const canPlay = {};
      const mediaSource = {};
      for (const type of types) {
        canPlay[type] = element.canPlayType(type);
        mediaSource[type] = window.MediaSource ? MediaSource.isTypeSupported(type) : null;
      }
      const recorder = {};
      if (window.MediaRecorder) {
        for (const type of ["video/webm", "video/mp4", "audio/webm", "audio/mp4"])
          recorder[type] = MediaRecorder.isTypeSupported(type);
      }
      // canPlayType does not answer for image MIME types; decode a real PNG.
      const onePixelPng =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      let pngDecode;
      try {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", () => reject(new Error("png decode rejected")), { once: true });
          image.src = onePixelPng;
        });
        pngDecode = { outcome: "resolved", size: [image.naturalWidth, image.naturalHeight] };
      } catch (error) {
        pngDecode = { outcome: "rejected", reason: error.message };
      }
      return {
        canPlay,
        mediaSource,
        recorder,
        pngDecode,
        manrostream: typeof window.MediaSource,
        mediaCapabilities: typeof navigator.mediaCapabilities?.decodingInfo,
        encryption: typeof navigator.requestMediaKeySystemAccess,
        audioContext: typeof window.AudioContext,
        videoDecode: typeof HTMLVideoElement.prototype.requestVideoFrameCallback,
      };
    });
    const values = Object.values(observed.canPlay);
    return invariant(observed, [
      ["canPlayValuesValid", values.every((value) => ["", "maybe", "probably"].includes(value))],
      ["pngDecodable", observed.pngDecode.outcome === "resolved" && observed.pngDecode.size[0] === 1],
      ["mediaSourcePresent", observed.manrostream === "function"],
      ["audioContextPresent", observed.audioContext === "function"],
      ["recorderAnswersAreBoolean", Object.values(observed.recorder).every((value) => typeof value === "boolean")],
    ]);
  },
};


export const probes = [svgRaster, textMetrics, mediaCodecs];
