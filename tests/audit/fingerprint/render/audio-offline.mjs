// OfflineAudioContext: render determinism, scheduling accuracy and gain maths.
//
// All renders are offline and bounded. Real-time AudioContext output is never
// opened, so no audio device is required and no page autoplay policy applies.

import { HASH_SRC } from '../support/canvas.mjs';
import { finish, prepare, recorder } from '../support/common.mjs';

const FRAMES = 48_000;

const probe = {
  id: 'audio-offline',
  family: 'render',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none (offline rendering needs no gesture)',
    viewport: 'any',
    notes:
      'Two independent 1s renders plus one ramp render. Offline rendering is compute-bound, never realtime: the probe reports frames, sampleRate and renderedSeconds separately and never compares wall-clock time to audio duration.',
    checks: [
      'audio/context-available',
      'audio/length-and-rate',
      'audio/render-deterministic',
      'audio/channel-read-deterministic',
      'audio/channels-identical',
      'audio/peak-within-gain',
      'audio/scheduled-start-silence',
      'audio/scheduled-stop-silence',
      'audio/ramp-accuracy'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(
      async (input) => {
        if (typeof OfflineAudioContext !== 'function') return { available: false };
        const hash = eval(input.hash);
        const frames = input.frames;

        const bytesOf = (channel) => new Uint8Array(channel.buffer.slice(0, channel.length * 4));
        const scene = async () => {
          const context = new OfflineAudioContext(2, frames, 48_000);
          const oscillator = context.createOscillator();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(440, 0);
          const gain = context.createGain();
          gain.gain.setValueAtTime(0.1, 0);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(0.25);
          oscillator.stop(0.75);
          const buffer = await context.startRendering();
          const left = buffer.getChannelData(0);
          const right = buffer.getChannelData(1);
          const leftAgain = buffer.getChannelData(0);
          let peak = 0;
          let energy = 0;
          for (let index = 0; index < left.length; index++) {
            const magnitude = Math.abs(left[index]);
            if (magnitude > peak) peak = magnitude;
            energy += left[index] * left[index];
          }
          let headPeak = 0;
          for (let index = 0; index < Math.floor(0.2 * buffer.sampleRate); index++) {
            headPeak = Math.max(headPeak, Math.abs(left[index]));
          }
          let tailPeak = 0;
          for (let index = Math.floor(0.8 * buffer.sampleRate); index < left.length; index++) {
            tailPeak = Math.max(tailPeak, Math.abs(left[index]));
          }
          return {
            digest: hash(bytesOf(left)),
            repeatDigest: hash(bytesOf(leftAgain)),
            rightDigest: hash(bytesOf(right)),
            channels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
            renderedSeconds: buffer.length / buffer.sampleRate,
            peak: Number(peak.toFixed(6)),
            rms: Number(Math.sqrt(energy / left.length).toFixed(6)),
            headPeak: Number(headPeak.toExponential(3)),
            tailPeak: Number(tailPeak.toExponential(3)),
            firstSamples: Array.from(left.slice(0, 4), (entry) => Number(entry.toFixed(8)))
          };
        };

        const first = await scene();
        const second = await scene();

        let ramp = null;
        let rampError = null;
        try {
          if (typeof ConstantSourceNode !== 'function') throw new Error('ConstantSourceNode absent');
          const context = new OfflineAudioContext(1, frames, 48_000);
          const source = context.createConstantSource();
          source.offset.setValueAtTime(1, 0);
          const gain = context.createGain();
          gain.gain.setValueAtTime(0, 0);
          gain.gain.linearRampToValueAtTime(1, 0.5);
          gain.gain.setValueAtTime(0.5, 0.5);
          source.connect(gain).connect(context.destination);
          source.start(0);
          source.stop(1);
          const buffer = await context.startRendering();
          const data = buffer.getChannelData(0);
          const at = (seconds) => data[Math.floor(seconds * buffer.sampleRate)];
          ramp = {
            atZero: Number(at(0).toFixed(6)),
            atQuarter: Number(at(0.25).toFixed(6)),
            atHalf: Number(at(0.5).toFixed(6)),
            atThreeQuarters: Number(at(0.75).toFixed(6))
          };
        } catch (error) {
          rampError = error.message ?? String(error);
        }

        return { available: true, first, second, ramp, rampError };
      },
      { hash: HASH_SRC, frames: FRAMES }
    );

    if (!observed.available) {
      rec.unknown('audio/context-available', 'OfflineAudioContext absent');
      for (const name of [
        'audio/length-and-rate',
        'audio/render-deterministic',
        'audio/channel-read-deterministic',
        'audio/channels-identical',
        'audio/peak-within-gain',
        'audio/scheduled-start-silence',
        'audio/scheduled-stop-silence',
        'audio/ramp-accuracy'
      ]) {
        rec.unknown(name, 'OfflineAudioContext absent');
      }
      rec.limit('offline-audio-absent', 'OfflineAudioContext is not exposed');
      return finish(rec, observed);
    }

    const first = observed.first;
    const second = observed.second;
    rec.expect('audio/context-available', true);
    rec.expect(
      'audio/length-and-rate',
      first.channels === 2 && first.length === FRAMES && first.sampleRate === 48_000,
      { channels: first.channels, length: first.length, sampleRate: first.sampleRate }
    );
    rec.expect('audio/render-deterministic', first.digest === second.digest, {
      first: first.digest,
      second: second.digest
    });
    rec.expect('audio/channel-read-deterministic', first.digest === first.repeatDigest);
    rec.expect('audio/channels-identical', first.digest === first.rightDigest);
    rec.expect('audio/peak-within-gain', first.peak > 0.09 && first.peak < 0.11, first.peak);
    rec.expect('audio/scheduled-start-silence', first.headPeak < 1e-6, first.headPeak);
    rec.expect('audio/scheduled-stop-silence', first.tailPeak < 1e-6, first.tailPeak);

    if (!observed.ramp) {
      rec.unknown('audio/ramp-accuracy', observed.rampError);
      rec.limit('constant-source-unavailable', observed.rampError);
    } else {
      const ramp = observed.ramp;
      rec.expect(
        'audio/ramp-accuracy',
        Math.abs(ramp.atZero) < 1e-6 &&
          Math.abs(ramp.atQuarter - 0.5) < 0.01 &&
          Math.abs(ramp.atHalf - 0.5) < 0.01 &&
          Math.abs(ramp.atThreeQuarters - 0.5) < 0.01,
        ramp
      );
    }

    return finish(rec, {
      first,
      second,
      ramp: observed.ramp,
      offline: {
        frames: first.length,
        sampleRate: first.sampleRate,
        renderedSeconds: first.renderedSeconds,
        channels: first.channels,
        note: 'Offline render: compute-bound, not realtime. Wall-clock duration is not part of the observation.'
      }
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
