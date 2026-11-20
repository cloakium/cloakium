// WebGPU adapter identity and limits.
//
// A null adapter is a normal, honest outcome on many hosts: it is recorded as a
// coverage gap. This probe never claims GPU behaviour was tested when the
// adapter could not be created.

import { finish, prepare, recorder } from '../support/common.mjs';
import { deviceLimitsWithinAdapter } from '../support/gpu-contracts.mjs';

const probe = {
  id: 'webgpu-adapter',
  family: 'render',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Bounded requestAdapter/requestDevice. A null adapter yields coverage=unknown, never a pass.',
    checks: [
      'webgpu/object-present',
      'webgpu/preferred-canvas-format',
      'webgpu/adapter-resolved',
      'webgpu/adapter-repeatable',
      'webgpu/adapter-features-array',
      'webgpu/adapter-limits-plausible',
      'webgpu/fallback-adapter-boolean',
      'webgpu/device-limits-match-adapter'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      if (!('gpu' in navigator)) return { gpuObject: false };
      const gpu = navigator.gpu;
      const preferredFormat =
        typeof gpu.getPreferredCanvasFormat === 'function' ? gpu.getPreferredCanvasFormat() : null;

      const requestAdapter = (options) =>
        Promise.race([
          gpu.requestAdapter(options),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000))
        ]);

      const first = await requestAdapter({ powerPreference: 'low-power' });
      if (first === 'timeout' || !first) {
        return { gpuObject: true, preferredFormat, adapter: first === 'timeout' ? 'timeout' : null };
      }
      const second = await requestAdapter({ powerPreference: 'low-power' });
      const describe = (adapter) => {
        const info = adapter.info ?? {};
        const limits = {};
        for (const key of [
          'maxTextureDimension1D',
          'maxTextureDimension2D',
          'maxTextureDimension3D',
          'maxBufferSize',
          'maxBindGroups',
          'maxComputeWorkgroupSizeX',
          'maxComputeInvocationsPerWorkgroup',
          'minUniformBufferOffsetAlignment',
          'maxVertexAttributes',
          'maxSampledTexturesPerShaderStage'
        ]) {
          limits[key] = adapter.limits?.[key] ?? null;
        }
        return {
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
          subgroupMinSize: info.subgroupMinSize ?? null,
          subgroupMaxSize: info.subgroupMaxSize ?? null,
          isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
          features: [...adapter.features].sort(),
          limits
        };
      };
      const adapter = describe(first);
      const adapterRepeat = second && second !== 'timeout' ? describe(second) : null;

      let device = null;
      let deviceError = null;
      try {
        const created = await Promise.race([
          first.requestDevice(),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000))
        ]);
        if (created === 'timeout') deviceError = 'requestDevice timed out';
        else {
          device = { limits: { maxTextureDimension2D: created.limits.maxTextureDimension2D, maxBufferSize: created.limits.maxBufferSize } };
          created.lost?.then(() => undefined).catch(() => undefined);
          created.destroy?.();
        }
      } catch (error) {
        deviceError = error.message ?? String(error);
      }

      return { gpuObject: true, preferredFormat, adapter, adapterRepeat, device, deviceError };
    });

    if (!observed.gpuObject) {
      rec.unknown('webgpu/object-present', 'navigator.gpu absent');
      for (const name of [
        'webgpu/preferred-canvas-format',
        'webgpu/adapter-resolved',
        'webgpu/adapter-repeatable',
        'webgpu/adapter-features-array',
        'webgpu/adapter-limits-plausible',
        'webgpu/fallback-adapter-boolean',
        'webgpu/device-limits-match-adapter'
      ]) {
        rec.unknown(name, 'navigator.gpu absent');
      }
      rec.limit('webgpu-absent', 'navigator.gpu is not exposed by this context');
      return finish(rec, observed);
    }

    rec.expect('webgpu/object-present', true);
    if (observed.preferredFormat === null) {
      rec.unknown('webgpu/preferred-canvas-format', 'getPreferredCanvasFormat absent');
    } else {
      rec.expect(
        'webgpu/preferred-canvas-format',
        ['bgra8unorm', 'rgba8unorm'].includes(observed.preferredFormat),
        observed.preferredFormat
      );
    }

    if (!observed.adapter || observed.adapter === 'timeout') {
      rec.unknown('webgpu/adapter-resolved', observed.adapter === 'timeout' ? 'requestAdapter timed out' : 'null adapter');
      for (const name of [
        'webgpu/adapter-repeatable',
        'webgpu/adapter-features-array',
        'webgpu/adapter-limits-plausible',
        'webgpu/fallback-adapter-boolean',
        'webgpu/device-limits-match-adapter'
      ]) {
        rec.unknown(name, 'no adapter');
      }
      rec.limit('webgpu-adapter-null', 'requestAdapter returned no adapter; GPU behaviour is NOT tested');
      return finish(rec, observed);
    }

    const adapter = observed.adapter;
    rec.expect('webgpu/adapter-resolved', true);
    rec.expect(
      'webgpu/adapter-repeatable',
      observed.adapterRepeat !== null && JSON.stringify(observed.adapterRepeat) === JSON.stringify(adapter)
    );
    rec.expect('webgpu/adapter-features-array', Array.isArray(adapter.features));
    rec.expect(
      'webgpu/adapter-limits-plausible',
      adapter.limits.maxTextureDimension2D >= 2048 &&
        adapter.limits.maxBufferSize >= 134_217_728 &&
        adapter.limits.maxBindGroups >= 4,
      adapter.limits
    );
    if (adapter.isFallbackAdapter === null) {
      rec.unknown('webgpu/fallback-adapter-boolean', 'No current or legacy fallback-adapter property');
      rec.limit('webgpu-fallback-metadata-unavailable', 'GPUAdapterInfo.isFallbackAdapter and its removed legacy location are absent');
    } else {
      rec.expect('webgpu/fallback-adapter-boolean', typeof adapter.isFallbackAdapter === 'boolean', adapter.isFallbackAdapter);
    }
    if (!observed.device) {
      rec.unknown('webgpu/device-limits-match-adapter', observed.deviceError);
      rec.limit('webgpu-device-unavailable', observed.deviceError);
    } else {
      rec.expect(
        'webgpu/device-limits-match-adapter',
        deviceLimitsWithinAdapter(observed.device.limits, adapter.limits),
        { device: observed.device.limits, adapter: adapter.limits, rule: 'Default device limits may be lower than adapter limits.' }
      );
    }

    return finish(rec, observed);
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
