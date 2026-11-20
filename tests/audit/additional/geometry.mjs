// CSSOM geometry coherence: DOMRect invariants, transforms, subpixel values,
// repeated reads and cross-realm agreement.
//
// No expected pixel value is assumed beyond CSS arithmetic that the probe itself
// declares. A per-document noise patch is an intentional vendor strategy; it
// will make repeat checks fail for a fixed-persona requirement.

import { acquirePage, closeQuietly, finish, fnv, recorder, round } from "./support.mjs";

const probe = {
  id: "geometry/dom-rect-invariants",
  family: "geometry",
  timeoutMs: 30_000,
  contextOptions: {},
  async run({ page, context, origin }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    try {
      const observed = await owned.page.evaluate(async () => {
        const host = document.createElement("div");
        host.style.cssText = "all:initial;position:absolute;left:0;top:0;margin:0;padding:0";
        document.body.append(host);

        const box = (id, css, html) => {
          const element = document.createElement("div");
          element.id = id;
          element.style.cssText = `position:absolute;box-sizing:border-box;${css}`;
          if (html !== undefined) element.innerHTML = html;
          host.append(element);
          return element;
        };

        const plain = box("plain", "left:40px;top:30px;width:120px;height:80px");
        const scaled = box("scaled", "left:200px;top:30px;width:50px;height:50px;transform:scale(2);transform-origin:0 0");
        const rotated = box("rotated", "left:400px;top:30px;width:60px;height:60px;transform:rotate(45deg);transform-origin:0 0");
        const subpixel = box("subpixel", "left:600px;top:30px;width:10.5px;height:10px");
        const inlineHost = box("inline-host", "left:40px;top:200px;width:60px;word-break:break-all");
        const inline = document.createElement("span");
        inline.id = "inline";
        inline.style.cssText = "background:transparent";
        inline.textContent = "abcdefghijklmnopqrstuvwxyz0123456789";
        inlineHost.append(inline);

        const frame = document.createElement("iframe");
        frame.id = "frame";
        frame.style.cssText = "position:absolute;left:40px;top:300px;width:300px;height:200px;border:0";
        frame.srcdoc =
          "<!doctype html><body style=\"margin:0\"><div id=frame-plain style=\"position:absolute;left:10px;top:20px;width:100px;height:50px;box-sizing:border-box\"></div></body>";
        host.append(frame);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          frame.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
        });

        const rect = (element) => {
          const value = element.getBoundingClientRect();
          return {
            x: value.x, y: value.y, width: value.width, height: value.height,
            top: value.top, right: value.right, bottom: value.bottom, left: value.left,
          };
        };
        const rectList = (element) =>
          Array.from(element.getClientRects(), (value) => ({
            x: value.x, y: value.y, width: value.width, height: value.height,
            top: value.top, right: value.right, bottom: value.bottom, left: value.left,
          }));

        const readAll = () => ({
          plain: rect(plain), scaled: rect(scaled), rotated: rect(rotated),
          subpixel: rect(subpixel), inline: rectList(inline),
          inlineBounds: rect(inline), inlineHost: rect(inlineHost),
        });

        const samples = [];
        for (let index = 0; index < 5; index += 1) {
          samples.push(readAll());
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
        const first = samples[0];
        const serialized = samples.map((sample) => JSON.stringify(sample));
        const plainElement = plain;
        const plainDomRect = plain.getBoundingClientRect();
        const frameBox = frame.contentDocument?.getElementById("frame-plain");
        const result = {
          first,
          repeatsIdentical: serialized.every((value) => value === serialized[0]),
          repeatCount: serialized.length,
          devicePixelRatio,
          elementChecks: {
            ownGetter: Object.hasOwn(plainElement, "getBoundingClientRect"),
            rectInstance: plainDomRect instanceof DOMRect,
            rectPrototype: Object.getPrototypeOf(plainDomRect) === DOMRect.prototype,
            toJSONKeys: Object.keys(plainDomRect.toJSON()).sort(),
            ownInlineGetter: Object.hasOwn(inline, "getClientRects"),
          },
          iframe: frameBox
            ? { width: frameBox.getBoundingClientRect().width, height: frameBox.getBoundingClientRect().height }
            : null,
        };
        host.remove();
        return result;
      });

      const allRects = [
        observed.first.plain, observed.first.scaled, observed.first.rotated,
        observed.first.subpixel, observed.first.inlineBounds, observed.first.inlineHost,
        ...observed.first.inline,
      ];
      const invariants = allRects.every(
        (rect) =>
          Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
          Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
          Math.abs(rect.right - (rect.x + rect.width)) < 1e-6 &&
          Math.abs(rect.bottom - (rect.y + rect.height)) < 1e-6 &&
          Math.abs(rect.left - rect.x) < 1e-6 && Math.abs(rect.top - rect.y) < 1e-6 &&
          rect.width >= 0 && rect.height >= 0,
      );
      const inlineUnion = observed.first.inline.reduce(
        (box, rect) => ({
          left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top),
          right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      );

      rec.expect("plain rect matches declared layout", Math.abs(observed.first.plain.width - 120) < 0.01 && Math.abs(observed.first.plain.height - 80) < 0.01);
      rec.expect("DOMRect arithmetic invariants hold for every rect", invariants);
      rec.expect("repeated reads are identical across animation frames", observed.repeatsIdentical);
      rec.expect("scale transform doubles the border box", Math.abs(observed.first.scaled.width - 100) < 0.5 && Math.abs(observed.first.scaled.height - 100) < 0.5);
      rec.expect("rotate transform bounds a 60px square as 60*sqrt(2)", Math.abs(observed.first.rotated.width - 60 * Math.SQRT2) < 0.5);
      rec.expect("fractional CSS width survives layout and readback", observed.first.subpixel.width > 10.4 && observed.first.subpixel.width < 10.6);
      rec.expect("inline element split across lines reports multiple client rects", observed.first.inline.length >= 2);
      rec.expect("inline client-rect union agrees with bounding rect", Math.abs(inlineUnion.left - observed.first.inlineBounds.left) <= 1 && Math.abs(inlineUnion.right - observed.first.inlineBounds.right) <= 1);
      rec.expect("DOMRect is a real DOMRect without own element getters", observed.elementChecks.rectInstance && observed.elementChecks.rectPrototype && !observed.elementChecks.ownGetter && !observed.elementChecks.ownInlineGetter);
      rec.expect("DOMRect.toJSON exposes the eight rectangle fields", JSON.stringify(observed.elementChecks.toJSONKeys) === JSON.stringify(["bottom", "height", "left", "right", "top", "width", "x", "y"]));
      rec.expect("devicePixelRatio is plausible", observed.devicePixelRatio >= 0.5 && observed.devicePixelRatio <= 4);
      if (observed.iframe) {
        rec.expect("same-origin iframe reports the same declared box", Math.abs(observed.iframe.width - 100) < 0.5 && Math.abs(observed.iframe.height - 50) < 0.5);
      } else {
        rec.unknown("same-origin iframe reports the same declared box", "unavailable", "frame document did not load");
      }
      rec.limit("noise-strategy", "Client-rect noise (ungoogled-chromium, Helium, Cromite) intentionally breaks repeat equality; a fixed-persona audit requires equality.");

      return finish(rec, {
        plain: observed.first.plain,
        scaled: observed.first.scaled,
        rotated: observed.first.rotated,
        subpixel: observed.first.subpixel,
        inlineRects: observed.first.inline.length,
        inlineUnion: { ...inlineUnion, width: round(inlineUnion.right - inlineUnion.left) },
        inlineBounds: observed.first.inlineBounds,
        repeatsIdentical: observed.repeatsIdentical,
        repeatCount: observed.repeatCount,
        devicePixelRatio: observed.devicePixelRatio,
        elementChecks: observed.elementChecks,
        iframe: observed.iframe,
        sampleDigest: fnv(JSON.stringify(observed.first)),
      });
    } finally {
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
