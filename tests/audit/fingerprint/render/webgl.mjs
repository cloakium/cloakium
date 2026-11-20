// WebGL 1/2 parameter, extension, readback and context-loss coherence.
//
// Parameters are recorded verbatim so a persona override can be diffed, but the
// verdicts only cover internal consistency: non-empty identity strings, sane
// limits, resolvable extensions, deterministic readback and a stable identity
// across a forced context loss. Nothing here assumes a specific GPU.

import { HASH_SRC } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const PARAMS = [
  'VENDOR',
  'RENDERER',
  'VERSION',
  'SHADING_LANGUAGE_VERSION',
  'MAX_TEXTURE_SIZE',
  'MAX_RENDERBUFFER_SIZE',
  'MAX_CUBE_MAP_TEXTURE_SIZE',
  'MAX_VIEWPORT_DIMS',
  'MAX_VERTEX_ATTRIBS',
  'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_FRAGMENT_UNIFORM_VECTORS',
  'MAX_VARYING_VECTORS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
  'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'ALIASED_LINE_WIDTH_RANGE',
  'ALIASED_POINT_SIZE_RANGE',
  'RED_BITS',
  'GREEN_BITS',
  'BLUE_BITS',
  'ALPHA_BITS',
  'DEPTH_BITS',
  'STENCIL_BITS',
  'SUBPIXEL_BITS',
  'SAMPLES'
];

const probe = {
  id: 'webgl-surface',
  family: 'render',
  budgetMs: 20_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Software or hardware GL both acceptable. Context-loss restore is event-driven with a 4s bound.',
    checks: [
      'webgl/context-available',
      'webgl/identity-non-empty',
      'webgl/unmasked-non-empty',
      'webgl/extensions-non-empty',
      'webgl/extensions-resolvable',
      'webgl/limits-coherent',
      'webgl/precision-supported',
      'webgl/params-deterministic',
      'webgl/readback-deterministic',
      'webgl/redraw-stable',
      'webgl/cleared-pixels-exact',
      'webgl/webgl2-available',
      'webgl/webgl2-version-string',
      'webgl2/readback-deterministic',
      'webgl/context-loss-restores-identity'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async (input) => {
        const hash = eval(input.hash);
        const params = input.params;
        const size = 48;

        const value = (gl, name) => {
          const raw = gl.getParameter(gl[name]);
          if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
          if (raw == null) return null;
          if (Array.isArray(raw) || ArrayBuffer.isView(raw)) return Array.from(raw, (entry) => Number(entry));
          return String(raw);
        };

        const collect = async (kind) => {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          document.body.append(canvas);
          const gl = canvas.getContext(kind, {
            antialias: false,
            preserveDrawingBuffer: true,
            alpha: false,
            depth: true,
            stencil: true,
            powerPreference: 'default'
          });
          if (!gl) return { available: false };

          const readParams = () => {
            const result = {};
            for (const name of params) {
              if (gl[name] === undefined) continue;
              result[name] = value(gl, name);
            }
            return result;
          };
          const first = readParams();
          const second = readParams();

          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const unmasked = debug
            ? {
                vendor: String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
                renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
              }
            : null;

          const supported = gl.getSupportedExtensions().slice().sort();
          const resolved = {};
          for (const name of supported) resolved[name] = gl.getExtension(name) !== null;

          const precision = {
            vertexHigh: gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
            fragmentHigh: gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
            fragmentMedium: gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT)
          };
          const precisionValue = (format) =>
            format
              ? { rangeMin: format.rangeMin, rangeMax: format.rangeMax, precision: format.precision }
              : null;

          const render = () => {
            gl.viewport(0, 0, size, size);
            gl.disable(gl.SCISSOR_TEST);
            gl.clearColor(0.2, 0.4, 0.6, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(0, 0, size / 2, size / 2);
            gl.clearColor(1, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.disable(gl.SCISSOR_TEST);
          };
          const readAll = () => {
            const pixels = new Uint8Array(size * size * 4);
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return pixels;
          };

          const errorsBeforeDraw = [];
          for (let count = 0; count < 16; count++) {
            const error = gl.getError();
            if (error === gl.NO_ERROR) break;
            errorsBeforeDraw.push(error);
          }
          render();
          const pixels = readAll();
          const repeat = readAll();
          const drawStatus = {
            error: gl.getError(), contextLost: gl.isContextLost(),
            framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER),
            errorsBeforeDraw,
          };
          const contextAttributes = gl.getContextAttributes?.() ?? null;
          const digest = hash(pixels);
          const repeatDigest = hash(repeat);

          render();
          const redrawDigest = hash(readAll());

          const pixel = (pixels, x, y) => {
            const offset = (y * size + x) * 4;
            return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
          };
          const corners = {
            lowerLeft: pixel(pixels, 1, 1),
            upperRight: pixel(pixels, size - 2, size - 2)
          };

          let loss = null;
          const lose = gl.getExtension('WEBGL_lose_context');
          if (!lose) {
            loss = { supported: false };
          } else {
            const waitFor = (name, ms) =>
              new Promise((resolve) => {
                const timer = setTimeout(() => {
                  canvas.removeEventListener(name, handler);
                  resolve(false);
                }, ms);
                const handler = event => {
                  if (name === 'webglcontextlost') event.preventDefault();
                  clearTimeout(timer);
                  canvas.removeEventListener(name, handler);
                  resolve(true);
                };
                canvas.addEventListener(name, handler);
              });
            const lost = waitFor('webglcontextlost', 3000);
            lose.loseContext();
            const didLose = await lost;
            if (!didLose) {
              loss = { supported: true, lost: false };
            } else {
              const restored = waitFor('webglcontextrestored', 3000);
              lose.restoreContext();
              const didRestore = await restored;
              loss = {
                supported: true,
                lost: true,
                restored: didRestore,
                vendorAfter: didRestore ? String(gl.getParameter(gl.VENDOR)) : null,
                rendererAfter: didRestore ? String(gl.getParameter(gl.RENDERER)) : null
              };
            }
          }

          return {
            available: true,
            params: first,
            paramsRepeatEqual: JSON.stringify(first) === JSON.stringify(second),
            unmasked,
            extensions: supported,
            extensionsResolved: resolved,
            precision: {
              vertexHigh: precisionValue(precision.vertexHigh),
              fragmentHigh: precisionValue(precision.fragmentHigh),
              fragmentMedium: precisionValue(precision.fragmentMedium)
            },
            digest,
            repeatDigest,
            redrawDigest,
            corners,
            contextAttributes,
            drawStatus,
            loss
          };
        };

        return { webgl1: await collect('webgl'), webgl2: await collect('webgl2') };
      },
      { hash: HASH_SRC, params: PARAMS }
    );

    const gl1 = observed.webgl1;
    if (!gl1.available) {
      rec.unknown('webgl/context-available', 'getContext("webgl") returned null');
      rec.limit('webgl-unavailable', 'WebGL 1 is not available in this context');
      for (const name of [
        'webgl/identity-non-empty',
        'webgl/unmasked-non-empty',
        'webgl/extensions-non-empty',
        'webgl/extensions-resolvable',
        'webgl/limits-coherent',
        'webgl/precision-supported',
        'webgl/params-deterministic',
        'webgl/readback-deterministic',
        'webgl/redraw-stable',
        'webgl/cleared-pixels-exact'
      ]) {
        rec.unknown(name, 'WebGL 1 unavailable');
      }
    } else {
      rec.expect('webgl/context-available', true);
      const identity = [gl1.params.VENDOR, gl1.params.RENDERER, gl1.params.VERSION];
      rec.expect(
        'webgl/identity-non-empty',
        identity.every((entry) => typeof entry === 'string' && entry.length > 0),
        identity
      );
      if (!gl1.unmasked) {
        rec.unknown('webgl/unmasked-non-empty', 'WEBGL_debug_renderer_info absent');
      } else {
        rec.expect(
          'webgl/unmasked-non-empty',
          [gl1.unmasked.vendor, gl1.unmasked.renderer].every((entry) => entry.length > 0),
          gl1.unmasked
        );
      }
      rec.expect('webgl/extensions-non-empty', gl1.extensions.length > 10, gl1.extensions.length);
      const unresolved = Object.entries(gl1.extensionsResolved)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      rec.expect('webgl/extensions-resolvable', unresolved.length === 0, { unresolved });
      const maxTexture = gl1.params.MAX_TEXTURE_SIZE;
      const maxViewport = gl1.params.MAX_VIEWPORT_DIMS;
      const powerOfTwo = Number.isInteger(maxTexture) && (maxTexture & (maxTexture - 1)) === 0;
      rec.expect(
        'webgl/limits-coherent',
        powerOfTwo &&
          maxTexture >= 1024 &&
          Array.isArray(maxViewport) &&
          maxViewport[0] >= 1024 &&
          gl1.params.MAX_VERTEX_ATTRIBS >= 16 &&
          gl1.params.MAX_COMBINED_TEXTURE_IMAGE_UNITS >= 8 &&
          gl1.params.RED_BITS >= 8 &&
          gl1.params.DEPTH_BITS >= 16,
        {
          maxTexture,
          maxViewport,
          maxVertexAttribs: gl1.params.MAX_VERTEX_ATTRIBS,
          depthBits: gl1.params.DEPTH_BITS
        }
      );
      const vertexPrecision = gl1.precision.vertexHigh?.precision ?? 0;
      const fragmentPrecision = gl1.precision.fragmentHigh?.precision ?? 0;
      rec.expect(
        'webgl/precision-supported',
        vertexPrecision >= 23 && fragmentPrecision >= 16,
        { vertexPrecision, fragmentPrecision }
      );
      rec.expect('webgl/params-deterministic', gl1.paramsRepeatEqual === true);
      rec.expect('webgl/readback-deterministic', gl1.digest === gl1.repeatDigest, {
        first: gl1.digest,
        second: gl1.repeatDigest
      });
      rec.expect('webgl/redraw-stable', gl1.redrawDigest === gl1.digest);
      if (gl1.drawStatus.contextLost || gl1.drawStatus.error !== 0) {
        rec.unknown('webgl/cleared-pixels-exact', gl1.drawStatus);
        rec.limit('webgl-draw-unavailable', gl1.drawStatus);
      } else rec.expect(
        'webgl/cleared-pixels-exact',
        gl1.corners.lowerLeft[0] >= 254 &&
          gl1.corners.lowerLeft[1] <= 1 &&
          Math.abs(gl1.corners.upperRight[0] - 51) <= 1 &&
          Math.abs(gl1.corners.upperRight[1] - 102) <= 1 &&
          Math.abs(gl1.corners.upperRight[2] - 153) <= 1,
        gl1.corners
      );
    }

    const gl2 = observed.webgl2;
    if (!gl2.available) {
      rec.unknown('webgl/webgl2-available', 'getContext("webgl2") returned null');
      rec.unknown('webgl/webgl2-version-string', 'WebGL 2 unavailable');
      rec.limit('webgl2-unavailable', 'WebGL 2 is not available in this context');
    } else {
      rec.expect('webgl/webgl2-available', true);
      rec.expect(
        'webgl/webgl2-version-string',
        typeof gl2.params.VERSION === 'string' && /WebGL 2/.test(gl2.params.VERSION),
        gl2.params.VERSION
      );
      rec.expect('webgl2/readback-deterministic', gl2.digest === gl2.repeatDigest, {
        webgl2: { first: gl2.digest, second: gl2.repeatDigest }
      });
    }

    const lossSource = gl1.available ? gl1 : gl2;
    if (!lossSource?.available || !lossSource.loss?.supported) {
      rec.unknown('webgl/context-loss-restores-identity', lossSource?.loss?.supported === false ? 'WEBGL_lose_context absent' : 'no WebGL context');
      rec.limit('webgl-context-loss-untested', 'WEBGL_lose_context is not available');
    } else if (!lossSource.loss.lost) {
      rec.unknown('webgl/context-loss-restores-identity', lossSource.loss);
      rec.limit('webgl-context-loss-not-triggered', 'loseContext() did not report a lost context');
    } else if (!lossSource.loss.restored) {
      // No identity comparison is possible without restoration.
      rec.unknown('webgl/context-loss-restores-identity', lossSource.loss);
      rec.limit('webgl-context-loss-not-restored', 'restoreContext() did not restore within 3s');
    } else {
      rec.expect(
        'webgl/context-loss-restores-identity',
        lossSource.loss.vendorAfter === lossSource.params.VENDOR &&
          lossSource.loss.rendererAfter === lossSource.params.RENDERER,
        lossSource.loss
      );
    }

    const compact = (entry) =>
      entry.available
        ? {
            params: entry.params,
            unmasked: entry.unmasked,
            extensions: entry.extensions,
            precision: entry.precision,
            digest: entry.digest,
            repeatDigest: entry.repeatDigest,
            redrawDigest: entry.redrawDigest,
             corners: entry.corners,
             drawStatus: entry.drawStatus,
            loss: entry.loss,
            contextAttributes: entry.contextAttributes
          }
        : entry;
    return finish(rec, { webgl1: compact(gl1), webgl2: compact(gl2) });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
