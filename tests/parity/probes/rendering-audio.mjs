// Rendering parity probe: OfflineAudioContext render determinism and bounds.

import { FNV, invariant, openPage } from './rendering-support.mjs';

const webAudioOffline = {
  name: "rendering/webaudio-offline",
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin);
    const observed = await page.evaluate(async (fnvSource) => {
      const fnv = eval(fnvSource);
      const render = async () => {
        const offline = new OfflineAudioContext(2, 4800, 48000);
        const oscillator = offline.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = 440;
        const gain = offline.createGain();
        gain.gain.value = 0.1;
        oscillator.connect(gain);
        gain.connect(offline.destination);
        oscillator.start(0);
        const buffer = await offline.startRendering();
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        const secondRead = buffer.getChannelData(0);
        const bytes = new Uint8Array(left.buffer.slice(0, left.length * 4));
        const repeatBytes = new Uint8Array(secondRead.buffer.slice(0, secondRead.length * 4));
        let peak = 0;
        let power = 0;
        for (let index = 0; index < left.length; index++) {
          peak = Math.max(peak, Math.abs(left[index]));
          power += left[index] * left[index];
        }
        return {
          digest: fnv(bytes),
          repeatDigest: fnv(repeatBytes),
          rightDigest: fnv(new Uint8Array(right.buffer.slice(0, right.length * 4))),
          channels: buffer.numberOfChannels,
          length: buffer.length,
          sampleRate: buffer.sampleRate,
          peak: Number(peak.toFixed(6)),
          rms: Number(Math.sqrt(power / left.length).toFixed(6)),
          firstSamples: Array.from(left.slice(0, 4)).map((value) => Number(value.toFixed(8))),
        };
      };
      const first = await render();
      const second = await render();
      return { first, second, crossRenderDigestEqual: first.digest === second.digest };
    }, FNV);
    return invariant(observed, [
      ["twoChannels", observed.first.channels === 2],
      ["expectedLength", observed.first.length === 4800],
      ["expectedSampleRate", observed.first.sampleRate === 48000],
      ["channelReadDeterministic", observed.first.digest === observed.first.repeatDigest],
      ["renderDeterministic", observed.crossRenderDigestEqual],
      ["channelsDiffer", observed.first.digest !== observed.first.rightDigest],
      ["peakWithinGain", observed.first.peak > 0.05 && observed.first.peak < 0.2],
    ]);
  },
};


export const probes = [webAudioOffline];
