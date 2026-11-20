export const FNV = `(bytes) => {
  let a = 0x811c9dc5, b = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ ((bytes[i] + 0x9e) & 0xff), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}`;

export const DRAW = `(canvas, fill) => {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = fill || "#336699";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = "#ffffff";
  ctx.font = "16px monospace";
  ctx.fillText("cloakium", 6, 40);
  ctx.strokeStyle = "#ff8800";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(40, 40, 12, 0, Math.PI * 2);
  ctx.stroke();
  return ctx;
}`;

export function invariant(observations, checks) {
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failed.length) throw new Error(`invariant failed: ${failed.join(', ')}\n${JSON.stringify(observations)}`);
  return observations;
}

export async function openPage(context, origin) {
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.setContent("<!doctype html><html><body></body></html>");
  return page;
}

// Flat-region pixels stay on the painted fill colour, so their deviation from
// the fill is exactly the readback noise. `bound` is the allowed absolute
// deviation: 1 for a single readback, 2 for read -> putImageData -> read.
export const FLAT_ANALYSIS = `(data, width, x0, y0, w, h, base, bound) => {
  const histogram = {};
  let outOfRange = 0, alphaChanged = 0, changed = 0, maxAbsDelta = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const delta = data[offset + channel] - base[channel];
        if (Math.abs(delta) <= bound) histogram[String(delta)] = (histogram[String(delta)] || 0) + 1;
        else outOfRange += 1;
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta));
        if (delta !== 0) changed += 1;
      }
      if (data[offset + 3] !== 255) alphaChanged += 1;
    }
  }
  return { histogram, outOfRange, alphaChanged, changed, samples: w * h * 3, maxAbsDelta };
}`;

