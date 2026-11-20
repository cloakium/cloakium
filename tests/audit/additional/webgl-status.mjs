// WebGL clear/readback status semantics.
//
// Distinct from the existing parameter/extension probe: this checks whether a
// readback is actually valid, whether invalid calls fail with the specified
// error instead of returning pixels, and whether a lost context is never treated
// as a successful pixel observation.

import { acquirePage, closeQuietly, finish, recorder } from "./support.mjs";

const probe = {
  id: "render/webgl-readpixel-status",
  family: "render",
  timeoutMs: 30_000,
  contextOptions: {},
  async run({ page, context, origin }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    try {
      const observed = await owned.page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        canvas.style.cssText = "position:absolute;left:-1000px;top:0";
        document.body.append(canvas);
        const attributes = { antialias: false, preserveDrawingBuffer: true, alpha: false };
        let gl = canvas.getContext("webgl2", attributes);
        let contextType = gl ? "webgl2" : null;
        if (!gl) {
          gl = canvas.getContext("webgl", attributes);
          contextType = gl ? "webgl" : null;
        }
        if (!gl) return { available: false };

        const drain = () => {
          const errors = [];
          for (let index = 0; index < 8; index += 1) {
            const error = gl.getError();
            if (error === gl.NO_ERROR) break;
            errors.push(error);
          }
          return errors;
        };
        const waitFor = (type, budget) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), budget);
            canvas.addEventListener(type, () => { clearTimeout(timer); resolve("event"); }, { once: true });
          });

        drain();
        gl.viewport(0, 0, 8, 8);
        gl.clearColor(0.25, 0, 0.75, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixels = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const clearError = gl.getError();
        const status = (() => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return { value: gl.checkFramebufferStatus(gl.FRAMEBUFFER), complete: gl.FRAMEBUFFER_COMPLETE };
        })();

        drain();
        const sentinel = new Uint16Array([0xabab]);
        let invalidThrew = null;
        try {
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_SHORT_5_6_5, sentinel);
        } catch (error) {
          invalidThrew = `${error.name}: ${error.message}`;
        }
        const invalidError = gl.getError();
        const invalidUntouched = sentinel[0] === 0xabab;

        drain();
        const negative = new Uint8Array([0xab, 0xab, 0xab, 0xab]);
        gl.readPixels(0, 0, -1, 1, gl.RGBA, gl.UNSIGNED_BYTE, negative);
        const negativeError = gl.getError();

        const extension = gl.getExtension("WEBGL_lose_context");
        let loss = null;
        if (extension) {
          const lost = waitFor("webglcontextlost", 3000);
          extension.loseContext();
          const lossOutcome = await lost;
          const lostError = gl.getError();
          const isLostAfter = gl.isContextLost();
          const restored = waitFor("webglcontextrestored", 6000);
          extension.restoreContext();
          const restoreOutcome = await restored;
          const isLostAfterRestore = gl.isContextLost();
          let restoredPixels = null;
          let restoredError = null;
          if (!isLostAfterRestore) {
            drain();
            gl.clearColor(0.25, 0, 0.75, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const again = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, again);
            restoredPixels = Array.from(again);
            restoredError = gl.getError();
          }
          loss = {
            lossOutcome, restoreOutcome, lostError, isLostAfter, isLostAfterRestore,
            restoredPixels, restoredError,
          };
        }
        if (extension && !gl.isContextLost()) extension.loseContext();
        return {
          available: true,
          contextType,
          clearError,
          pixels: Array.from(pixels),
          framebufferStatus: status,
          invalidThrew,
          invalidError,
          invalidUntouched,
          negativeError,
          lossExtension: Boolean(extension),
          loss,
        };
      });

      if (!observed.available) {
        rec.unknown("WebGL context is available", "unavailable", "both webgl2 and webgl returned null");
        rec.unknown("clear produces exactly the declared bytes", "unavailable", "no context");
        rec.unknown("default framebuffer reports complete", "unavailable", "no context");
        rec.unknown("invalid readPixels reports INVALID_OPERATION", "unavailable", "no context");
        rec.unknown("invalid readPixels leaves the destination untouched", "unavailable", "no context");
        rec.unknown("negative width reports INVALID_VALUE", "unavailable", "no context");
        rec.unknown("context loss is observable and not a pixel pass", "unavailable", "no context");
        rec.unknown("restored context clears again", "unavailable", "no context");
        rec.limit("webgl-absent", "A null WebGL context can be a deliberate vendor policy (for example Cromite), not a browser defect.");
        return finish(rec, { available: false });
      }

      const expected = [64, 0, 191, 255];
      rec.expect("WebGL context is available", true, observed.contextType);
      rec.expect("clear produces exactly the declared bytes", JSON.stringify(observed.pixels) === JSON.stringify(expected) && observed.clearError === 0);
      rec.expect("default framebuffer reports complete", observed.framebufferStatus.value === observed.framebufferStatus.complete);
      rec.expect("invalid readPixels reports INVALID_OPERATION", observed.invalidError === 0x0502, observed.invalidThrew ? `threw ${observed.invalidThrew}` : `0x${observed.invalidError.toString(16)}`);
      rec.expect("invalid readPixels leaves the destination untouched", observed.invalidUntouched);
      rec.expect("negative width reports INVALID_VALUE", observed.negativeError === 0x0501);
      if (observed.lossExtension) {
        const loss = observed.loss;
        rec.expect("context loss is observable and not a pixel pass", loss.isLostAfter === true && (loss.lostError === 0 || loss.lostError === 0x9242));
        if (loss.restoreOutcome === "event" && loss.isLostAfterRestore === false) {
          rec.expect("restored context clears again", JSON.stringify(loss.restoredPixels) === JSON.stringify(expected) && (loss.restoredError === 0 || loss.restoredError === 0x9242 || loss.restoredError === null));
        } else {
          rec.unknown("restored context clears again", "unavailable", `host did not deliver a restored context (${loss.restoreOutcome})`);
        }
        rec.limit("loss-event", "The probe forces loss with WEBGL_lose_context; it does not test driver-initiated reset.");
      } else {
        rec.unknown("context loss is observable and not a pixel pass", "unavailable", "WEBGL_lose_context is not exposed");
        rec.unknown("restored context clears again", "unavailable", "WEBGL_lose_context is not exposed");
      }
      rec.limit("pixel-scope", "Only a 1x1 RGBA/UNSIGNED_BYTE readback is asserted; other formats are exercised only for their error path.");

      return finish(rec, {
        available: true,
        contextType: observed.contextType,
        pixels: observed.pixels,
        framebufferStatus: observed.framebufferStatus.value,
        invalidError: observed.invalidError,
        invalidThrew: observed.invalidThrew,
        invalidUntouched: observed.invalidUntouched,
        negativeError: observed.negativeError,
        lossExtension: observed.lossExtension,
        loss: observed.loss,
      });
    } finally {
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
