// AudioWorklet inside an OfflineAudioContext.
//
// The worklet module is built from a local Blob URL and renders a constant so the
// output is verifiable without any device or network. Absence is a declared
// coverage gap: a browser may legitimately disable worklets.

import { HASH_SRC } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const FRAMES = 12_000;
const PROCESSOR = `class ProbeConstant extends AudioWorkletProcessor {
  process(_inputs, outputs) {
    const channels = outputs[0];
    for (let index = 0; index < channels.length; index++) channels[index].fill(0.25);
    return true;
  }
}
registerProcessor('probe-constant', ProbeConstant);`;

const probe = {
  id: 'audio-worklet',
  family: 'render',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none (offline rendering needs no gesture)',
    viewport: 'any',
    notes: 'Blob-URL module only. Not all builds enable AudioWorklet in offline contexts.',
    checks: [
      'worklet/api-present',
      'worklet/module-loads',
      'worklet/output-constant',
      'worklet/render-deterministic',
      'worklet/no-processor-error'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async (input) => {
        if (typeof OfflineAudioContext !== 'function') return { available: false, reason: 'OfflineAudioContext absent' };
        if (typeof AudioWorkletNode !== 'function') return { available: false, reason: 'AudioWorkletNode absent' };
        const hash = eval(input.hash);
        const frames = input.frames;
        const bytesOf = (channel) => new Uint8Array(channel.buffer.slice(0, channel.length * 4));

        const render = async () => {
          const context = new OfflineAudioContext(1, frames, 48_000);
          if (!context.audioWorklet) throw new Error('audioWorklet absent on OfflineAudioContext');
          const url = URL.createObjectURL(new Blob([input.processor], { type: 'text/javascript' }));
          try {
            await context.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          const node = new AudioWorkletNode(context, 'probe-constant', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          let processorError = null;
          node.addEventListener('processorerror', (event) => {
            processorError = event.message ?? 'processorerror';
          });
          node.connect(context.destination);
          const buffer = await context.startRendering();
          const data = buffer.getChannelData(0);
          let minimum = Infinity;
          let maximum = -Infinity;
          for (let index = 0; index < data.length; index++) {
            minimum = Math.min(minimum, data[index]);
            maximum = Math.max(maximum, data[index]);
          }
          return {
            digest: hash(bytesOf(data)),
            length: buffer.length,
            sampleRate: buffer.sampleRate,
            minimum: Number(minimum.toFixed(6)),
            maximum: Number(maximum.toFixed(6)),
            processorError
          };
        };

        try {
          const first = await render();
          const second = await render();
          return { available: true, first, second };
        } catch (error) {
          return { available: true, error: error.message ?? String(error) };
        }
      },
      { hash: HASH_SRC, frames: FRAMES, processor: PROCESSOR }
    );

    if (!observed.available) {
      rec.unknown('worklet/api-present', observed.reason);
      for (const name of ['worklet/module-loads', 'worklet/output-constant', 'worklet/render-deterministic', 'worklet/no-processor-error']) {
        rec.unknown(name, observed.reason);
      }
      rec.limit('audioworklet-unavailable', observed.reason);
      return finish(rec, observed);
    }

    rec.expect('worklet/api-present', true);
    if (observed.error) {
      rec.unknown('worklet/module-loads', observed.error);
      for (const name of ['worklet/output-constant', 'worklet/render-deterministic', 'worklet/no-processor-error']) {
        rec.unknown(name, observed.error);
      }
      rec.limit('audioworklet-module-failed', observed.error);
      return finish(rec, observed);
    }

    const first = observed.first;
    rec.expect('worklet/module-loads', first.length === FRAMES && first.sampleRate === 48_000, {
      length: first.length,
      sampleRate: first.sampleRate
    });
    rec.expect(
      'worklet/output-constant',
      Math.abs(first.minimum - 0.25) < 1e-4 && Math.abs(first.maximum - 0.25) < 1e-4,
      { minimum: first.minimum, maximum: first.maximum }
    );
    rec.expect('worklet/render-deterministic', first.digest === observed.second.digest, {
      first: first.digest,
      second: observed.second.digest
    });
    rec.expect('worklet/no-processor-error', first.processorError === null && observed.second.processorError === null);

    return finish(rec, { first, second: observed.second });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
