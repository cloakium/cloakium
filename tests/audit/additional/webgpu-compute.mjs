// WebGPU compute and buffer readback.
//
// A null adapter is a coverage gap on this host, never a pass. A software or
// fallback adapter is acceptable for exercising the API, but it is labelled as
// fallback and is not evidence about a physical GPU.

import { acquirePage, closeQuietly, finish, recorder, round } from "./support.mjs";

const probe = {
  id: "compute/webgpu-readback",
  family: "compute",
  timeoutMs: 40_000,
  contextOptions: {},
  async run({ page, context, origin, deadline }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    try {
      const budget = Math.min(10_000, Math.max(1_000, (deadline ?? Infinity) - Date.now()));
      const observed = await owned.page.evaluate(async ({ budgetMs }) => {
        if (!("gpu" in navigator) || !navigator.gpu) return { gpuObject: false };
        const bounded = (promise, ms, label) =>
          Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
          ]);
        let adapter;
        try {
          adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: "low-power" }), budgetMs, "requestAdapter");
        } catch (error) {
          return { gpuObject: true, adapter: null, adapterError: `${error.name}: ${error.message}` };
        }
        if (!adapter) return { gpuObject: true, adapter: null, adapterError: "no adapter" };
        const info = adapter.info ?? {};
        const limits = {
          maxComputeWorkgroupSizeX: adapter.limits?.maxComputeWorkgroupSizeX ?? null,
          maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
          maxBufferSize: adapter.limits?.maxBufferSize ?? null,
        };
        let device;
        try {
          device = await bounded(adapter.requestDevice(), budgetMs, "requestDevice");
        } catch (error) {
          return {
            gpuObject: true,
            adapter: {
              vendor: info.vendor ?? null, architecture: info.architecture ?? null,
              device: info.device ?? null, description: info.description ?? null,
              isFallbackAdapter: adapter.isFallbackAdapter ?? null, limits,
              features: Array.from(adapter.features ?? []).sort(),
            },
            deviceError: `${error.name}: ${error.message}`,
          };
        }

        let input = null;
        let output = null;
        let validationError = null;
        let readbackBytes = null;
        try {
          device.pushErrorScope("validation");
          const source = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
          input = new Float32Array(source);
          const module = device.createShaderModule({
            code: `
              @group(0) @binding(0) var<storage, read_write> data: array<f32>;
              @compute @workgroup_size(64)
              fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                let index = id.x;
                if (index >= arrayLength(&data)) { return; }
                data[index] = data[index] * 2.0;
              }
            `,
          });
          const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module, entryPoint: "main" },
          });
          const size = source.byteLength;
          const storage = device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          });
          const reader = device.createBuffer({
            size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(storage, 0, source);
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: storage } }],
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(1);
          pass.end();
          encoder.copyBufferToBuffer(storage, 0, reader, 0, size);
          device.queue.submit([encoder.finish()]);
          await bounded(reader.mapAsync(GPUMapMode.READ), budgetMs, "mapAsync");
          const range = reader.getMappedRange();
          readbackBytes = range.byteLength;
          output = Array.from(new Float32Array(range.slice(0)));
          reader.unmap();
          storage.destroy();
          reader.destroy();
          validationError = await device.popErrorScope();
        } catch (error) {
          validationError = `${error.name}: ${error.message}`;
        } finally {
          device.destroy();
        }
        return {
          gpuObject: true,
          adapter: {
            vendor: info.vendor ?? null, architecture: info.architecture ?? null,
            device: info.device ?? null, description: info.description ?? null,
            isFallbackAdapter: adapter.isFallbackAdapter ?? null, limits,
            features: Array.from(adapter.features ?? []).sort(),
          },
          input: input ? Array.from(input) : null,
          output,
          readbackBytes,
          validationError: validationError ? String(validationError.message ?? validationError) : null,
        };
      }, { budgetMs: budget });

      if (observed.gpuObject) rec.expect("navigator.gpu exists", true);
      else rec.unknown("navigator.gpu exists", "unavailable", "navigator.gpu is not exposed; this can be a deliberate vendor policy");
      if (observed.adapter) {
        rec.expect("a GPU adapter resolved", true);
        rec.expect("adapter limits can run the probe's 64-wide workgroup", (observed.adapter.limits.maxComputeWorkgroupSizeX ?? 0) >= 64);
        const identity = [observed.adapter.vendor, observed.adapter.architecture, observed.adapter.device, observed.adapter.description].filter((value) => typeof value === "string" && value.length > 0);
        rec.expect("adapter reports at least one identity string", identity.length > 0, identity.join("/"));
      } else {
        rec.unknown("a GPU adapter resolved", "unavailable", observed.adapterError ?? "no adapter");
        rec.unknown("adapter limits can run the probe's 64-wide workgroup", "unavailable", "no adapter");
        rec.unknown("adapter reports at least one identity string", "unavailable", "no adapter");
      }
      if (observed.output) {
        rec.expect("device was created and compute ran", true);
        rec.expect("compute doubled every input element", JSON.stringify(observed.output) === JSON.stringify([2, 4, 6, 8, 10, 12, 14, 16]));
        rec.expect("readback byte length matches the source buffer", observed.readbackBytes === 32);
        rec.expect("no validation error was queued", observed.validationError === null);
      } else {
        const reason = observed.deviceError ?? observed.validationError ?? "compute did not produce output";
        rec.unknown("device was created and compute ran", "unavailable", reason);
        rec.unknown("compute doubled every input element", "unavailable", reason);
        rec.unknown("readback byte length matches the source buffer", "unavailable", reason);
        rec.unknown("no validation error was queued", "unavailable", reason);
      }
      rec.limit("software-adapter", "A fallback/software adapter can pass this probe; it is not physical-GPU evidence.");
      rec.limit("gpu-absent", "A null adapter is recorded as unavailable, never as a successful WebGPU surface.");

      return finish(rec, {
        adapter: observed.adapter ?? null,
        adapterError: observed.adapterError ?? null,
        input: observed.input ?? null,
        output: observed.output ?? null,
        readbackBytes: observed.readbackBytes ?? null,
        validationError: observed.validationError ?? null,
        outputRms: observed.output ? round(Math.sqrt(observed.output.reduce((sum, value) => sum + value * value, 0) / observed.output.length)) : null,
      });
    } finally {
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
