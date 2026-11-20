// Page-side source strings shared by the render probes.
//
// These are serialised into `page.evaluate` and re-instantiated with `eval`, so
// they must be self-contained and free of outer references.

// Two independent 32-bit lanes (FNV-1a and a djb2 variant) joined into one
// stable hex digest. Not cryptographic; only needs collision resistance over
// small pixel buffers.
export const HASH_SRC = `(bytes) => {
  let a = 0x811c9dc5 >>> 0;
  let b = 0x00001505 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = (Math.imul(b, 33) ^ bytes[i]) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}`;

// Fixed scene: solid fill, dark square, text, stroked arc, linear gradient.
// The bottom rows stay flat so readback noise can be measured against the fill.
export const DRAW_SRC = `(canvas, options) => {
  const o = options || {};
  const ctx = o.readFrequently
    ? canvas.getContext("2d", { willReadFrequently: true })
    : canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = o.fill || "#336699";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#0f0f0f";
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 8)), Math.max(1, Math.floor(h / 8)));
  ctx.fillStyle = "#ffffff";
  ctx.font = o.font || "16px monospace";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(o.text || "render probe 0123", 6, Math.round(h * 0.55));
  ctx.strokeStyle = "#ff8800";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(Math.round(w * 0.62), Math.round(h * 0.45), Math.round(w * 0.15), 0, Math.PI * 2);
  ctx.stroke();
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "rgba(0,128,255,0.35)");
  gradient.addColorStop(1, "rgba(255,64,0,0.35)");
  ctx.fillStyle = gradient;
  ctx.fillRect(Math.round(w * 0.15), Math.round(h * 0.1), Math.round(w * 0.5), Math.round(h * 0.25));
  return ctx;
}`;

// Measures deviation from an expected flat fill over a region. `bound` is the
// largest absolute per-channel deviation considered in-spec: 1 for one readback,
// 2 for read -> putImageData -> read.
export const FLAT_SRC = `(data, width, x0, y0, w, h, base, bound) => {
  const histogram = {};
  let outOfRange = 0;
  let alphaChanged = 0;
  let changed = 0;
  let maxAbsDelta = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const delta = data[offset + channel] - base[channel];
        const absolute = Math.abs(delta);
        if (absolute <= bound) histogram[String(delta)] = (histogram[String(delta)] || 0) + 1;
        else outOfRange += 1;
        if (absolute > maxAbsDelta) maxAbsDelta = absolute;
        if (delta !== 0) changed += 1;
      }
      if (data[offset + 3] !== 255) alphaChanged += 1;
    }
  }
  return { histogram, outOfRange, alphaChanged, changed, samples: w * h * 3, maxAbsDelta };
}`;

// Pixel extraction helper used when a probe needs a single sentinel pixel.
export const PIXEL_SRC = `(data, width, x, y) => {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}`;

export const PROBE_SIZE = 96;
export const FLAT_REGION = { x0: 0, y0: PROBE_SIZE - 3, w: PROBE_SIZE, h: 3 };
