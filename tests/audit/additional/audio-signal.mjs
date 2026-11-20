// Calibrated Web Audio signal behaviour.
//
// The probe never assumes a vendor amplitude or that a silent graph must be
// bit-zero. It calibrates gain response against itself, records the silence
// floor, and requires an active graph to differ from the silent graph.

import { acquirePage, closeQuietly, finish, fnv, recorder, round } from "./support.mjs";

const probe = {
  id: "audio/signal-calibration",
  family: "audio",
  timeoutMs: 40_000,
  contextOptions: {},
  async run({ page, context, origin }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    try {
      const observed = await owned.page.evaluate(async () => {
        if (typeof OfflineAudioContext !== "function") return { available: false };
        const stats = (data) => {
          let peak = 0;
          let power = 0;
          let nonZero = 0;
          let finite = true;
          for (let index = 0; index < data.length; index += 1) {
            const value = data[index];
            if (!Number.isFinite(value)) finite = false;
            const magnitude = Math.abs(value);
            if (magnitude > peak) peak = magnitude;
            if (magnitude > 0) nonZero += 1;
            power += value * value;
          }
          return {
            peak,
            rms: Math.sqrt(power / data.length),
            nonZero,
            finite,
            digest: digest(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
          };
        };
        const digest = (bytes) => {
          let hash = 0x811c9dc5;
          for (let index = 0; index < bytes.length; index += 1) {
            hash ^= bytes[index];
            hash = Math.imul(hash, 0x01000193);
          }
          return (hash >>> 0).toString(16).padStart(8, "0");
        };
        const render = async ({ gain, frequency }) => {
          const offline = new OfflineAudioContext(1, 4800, 48000);
          const oscillator = offline.createOscillator();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          const volume = offline.createGain();
          volume.gain.value = gain;
          oscillator.connect(volume).connect(offline.destination);
          oscillator.start(0);
          const buffer = await offline.startRendering();
          const data = buffer.getChannelData(0);
          return { channels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate, ...stats(data) };
        };
        const silent = await render({ gain: 0, frequency: 440 });
        const low = await render({ gain: 0.05, frequency: 440 });
        const high = await render({ gain: 0.5, frequency: 440 });
        const repeat = await render({ gain: 0.5, frequency: 440 });
        const other = await render({ gain: 0.5, frequency: 880 });
        return { silent, low, high, repeat, other };
      });

      if (observed.available === false) {
        rec.unknown("every render keeps the requested shape", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("active renders contain finite samples", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("active signal is non-silent", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("gain response is monotonic", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("gain response is calibrated within a factor-of-two band of 10", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("active and silent graphs differ", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("identical graphs render deterministically", "unavailable", "OfflineAudioContext is missing");
        rec.unknown("different frequencies produce different output", "unavailable", "OfflineAudioContext is missing");
        rec.limit("offline-audio-absent", "OfflineAudioContext is unavailable on this host; no amplitude or determinism verdict is possible.");
        return finish(rec, { available: false });
      }

      const shape = (sample) => sample.channels === 1 && sample.length === 4800 && sample.sampleRate === 48000;
      rec.expect("every render keeps the requested shape", [observed.silent, observed.low, observed.high, observed.repeat, observed.other].every(shape));
      rec.expect("active renders contain finite samples", observed.low.finite && observed.high.finite && observed.repeat.finite);
      rec.expect("active signal is non-silent", observed.high.rms > 0 && observed.high.peak > 0);
      rec.expect("gain response is monotonic", observed.high.rms > observed.low.rms);
      const ratio = observed.low.rms > 0 ? observed.high.rms / observed.low.rms : null;
      rec.expect("gain response is calibrated within a factor-of-two band of 10", ratio !== null && ratio >= 5 && ratio <= 20, ratio === null ? "zero low-gain RMS" : `ratio ${round(ratio, 3)}`);
      rec.expect("active and silent graphs differ", observed.high.digest !== observed.silent.digest && observed.high.rms > observed.silent.rms);
      rec.expect("identical graphs render deterministically", observed.high.digest === observed.repeat.digest);
      rec.expect("different frequencies produce different output", observed.high.digest !== observed.other.digest);
      rec.limit("silence-floor", `The silent graph RMS was ${round(observed.silent.rms)}; a vendor noise floor is recorded but not treated as a defect by itself.`);
      rec.limit("amplitude-scope", "No absolute oscillator amplitude is asserted; only the ratio between two declared gains.");
      rec.limit("offline-scope", "OfflineAudioContext is deterministic and does not exercise a physical output device or realtime clock.");

      return finish(rec, {
        silent: observed.silent,
        low: observed.low,
        high: observed.high,
        repeat: observed.repeat,
        other: observed.other,
        gainRatio: ratio,
        silenceDigest: observed.silent.digest,
        highDigest: observed.high.digest,
        combinedDigest: fnv(JSON.stringify(observed)),
      });
    } finally {
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
