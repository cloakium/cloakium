// Rendering parity probes: WebGL 1/2 profile and a bounded WebGPU adapter
// request.

import { FNV, invariant, openPage } from './rendering-support.mjs';

const webglProfile = {
  name: "rendering/webgl-profile",
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate((fnvSource) => {
      const fnv = eval(fnvSource);
      const collect = (kind) => {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const gl = canvas.getContext(kind, { antialias: false, preserveDrawingBuffer: true, alpha: false });
        if (!gl) return { available: false };
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const parameter = (name) => {
          const value = gl.getParameter(gl[name]);
          return typeof value === "number" ? value : value == null ? null : String(value);
        };
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        gl.clearColor(0.2, 0.4, 0.6, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, 16, 16);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
        const pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const redraw = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, redraw);
        return {
          available: true,
          vendor: parameter("VENDOR"),
          renderer: parameter("RENDERER"),
          version: parameter("VERSION"),
          shadingLanguageVersion: parameter("SHADING_LANGUAGE_VERSION"),
          unmaskedVendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
          unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
          debugExtension: Boolean(debug),
          maxTextureSize: parameter("MAX_TEXTURE_SIZE"),
          maxRenderbufferSize: parameter("MAX_RENDERBUFFER_SIZE"),
          maxViewportDims: viewport ? Array.from(viewport) : null,
          maxVertexAttribs: parameter("MAX_VERTEX_ATTRIBS"),
          aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []),
          maxCombinedTextureImageUnits: parameter("MAX_COMBINED_TEXTURE_IMAGE_UNITS"),
          extensions: gl.getSupportedExtensions().slice().sort(),
          pixelDigest: fnv(pixels),
          pixelRepeatDigest: fnv(redraw),
          corner: Array.from(pixels.slice(0, 4)),
          farCorner: Array.from(pixels.slice((31 * 32 + 31) * 4, (31 * 32 + 31) * 4 + 4)),
          contextAttributes: gl.getContextAttributes(),
        };
      };
      return { webgl1: collect("webgl"), webgl2: collect("webgl2") };
    }, FNV);
    const contexts = [observed.webgl1, observed.webgl2];
    return invariant(observed, [
      ["webgl1Available", observed.webgl1.available],
      ["rendererNonEmpty", contexts.every((ctx) => !ctx.available || (ctx.renderer && ctx.renderer.length > 0))],
      ["extensionsDeterministic", contexts.every((ctx) => !ctx.available || ctx.extensions.length > 0)],
      ["readbackDeterministic", contexts.every((ctx) => !ctx.available || ctx.pixelDigest === ctx.pixelRepeatDigest)],
      ["pixelsRendered", contexts.every((ctx) => !ctx.available || (ctx.corner[2] > 0 || ctx.corner[0] > 0))],
      ["maxTextureSizeSane", contexts.every((ctx) => !ctx.available || ctx.maxTextureSize >= 1024)],
    ]);
  },
};

const webgpuAdapter = {
  name: "rendering/webgpu-adapter",
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(async () => {
      if (!("gpu" in navigator)) return { gpuObject: false, adapter: null };
      const bounded = (promise, ms) =>
        Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);
      const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), 5000);
      if (!adapter || adapter === "timeout") return { gpuObject: true, adapter: adapter === "timeout" ? "timeout" : null };
      const info = adapter.info ?? {};
      const limits = {};
      for (const key of [
        "maxTextureDimension2D",
        "maxBufferSize",
        "maxComputeWorkgroupSizeX",
        "maxBindGroups",
        "minUniformBufferOffsetAlignment",
      ])
        limits[key] = adapter.limits?.[key] ?? null;
      return {
        gpuObject: true,
        adapter: {
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
          isFallbackAdapter: adapter.isFallbackAdapter ?? null,
          features: [...adapter.features].sort(),
          limits,
        },
      };
    });
    return invariant(observed, [
      ["gpuObjectPresent", observed.gpuObject === true],
      ["adapterResolved", observed.adapter !== "timeout"],
      ["adapterFeaturesArray", observed.adapter === null || Array.isArray(observed.adapter.features)],
      ["adapterLimitsSane", observed.adapter === null || observed.adapter.limits.maxTextureDimension2D === null || observed.adapter.limits.maxTextureDimension2D >= 2048],
    ]);
  },
};


export const probes = [webglProfile, webgpuAdapter];
