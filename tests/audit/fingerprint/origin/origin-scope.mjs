// Origin scoping of render perturbation.
//
// The same deterministic canvas and audio scenes are rendered at the harness
// origin and at its loopback cross-origin alias. Two questions matter: is the
// primary origin reproducible, and does a second origin change the output?
// Only the first is a hard requirement; the second is recorded, because not every
// implementation scopes perturbation by origin.

import { DRAW_SRC, HASH_SRC, PROBE_SIZE } from '../support/canvas.mjs';
import { closeQuietly, finish, newProbePage, prepare, recorder } from '../support/common.mjs';

const AUDIO_FRAMES = 12_000;

async function readAt(page, base) {
  await prepare(page, base);
  return page.evaluate(
    async (input) => {
      const draw = eval(input.draw);
      const hash = eval(input.hash);
      const size = input.size;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      document.body.append(canvas);
      draw(canvas, {});
      const data = canvas.getContext('2d').getImageData(0, 0, size, size);
      const canvasDigest = hash(new Uint8Array(data.data.buffer));

      let audioDigest = null;
      let audioError = null;
      try {
        if (typeof OfflineAudioContext === 'function') {
          const context = new OfflineAudioContext(1, input.audioFrames, 48_000);
          const oscillator = context.createOscillator();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(523.25, 0);
          const gain = context.createGain();
          gain.gain.setValueAtTime(0.2, 0);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(0);
          const buffer = await context.startRendering();
          const channel = buffer.getChannelData(0);
          audioDigest = hash(new Uint8Array(channel.buffer.slice(0, channel.length * 4)));
        }
      } catch (error) {
        audioError = error.message;
      }

      return { origin: location.origin, canvasDigest, audioDigest, audioError };
    },
    { draw: DRAW_SRC, hash: HASH_SRC, size: PROBE_SIZE, audioFrames: AUDIO_FRAMES }
  );
}

const probe = {
  id: 'origin-scope',
  family: 'origin',
  budgetMs: 18_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'required for the cross-origin half',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Cross-origin alias must be a second loopback origin served by the harness.',
    checks: [
      'origin/origins-distinct',
      'origin/same-origin-repeatable',
      'origin/same-origin-page-stable',
      'origin/cross-origin-repeatable',
      'origin/cross-origin-differs',
      'origin/audio-cross-origin-differs'
    ]
  },

  async run({ page, context, origin, crossOrigin }) {
    const rec = recorder();
    const primaryFirst = await readAt(page, origin);
    const primarySecond = await readAt(page, origin);

    let primaryPageTwo = null;
    let primaryOtherPage = null;
    try {
      primaryPageTwo = await newProbePage(context, origin);
      primaryOtherPage = await readAt(primaryPageTwo, origin);
    } finally {
      if (primaryPageTwo) await closeQuietly(primaryPageTwo);
    }

    const distinctOrigins = typeof crossOrigin === 'string' && crossOrigin.length > 0 && crossOrigin !== origin;
    let crossFirst = null;
    let crossSecond = null;
    if (distinctOrigins) {
      let crossPage = null;
      let crossPageTwo = null;
      try {
        crossPage = await newProbePage(context, crossOrigin);
        crossFirst = await readAt(crossPage, crossOrigin);
        crossPageTwo = await newProbePage(context, crossOrigin);
        crossSecond = await readAt(crossPageTwo, crossOrigin);
      } catch (error) {
        rec.limit('cross-origin-unavailable', error.message ?? String(error));
        crossFirst = null;
        crossSecond = null;
      } finally {
        if (crossPage) await closeQuietly(crossPage);
        if (crossPageTwo) await closeQuietly(crossPageTwo);
      }
    } else {
      rec.limit('cross-origin-unconfigured', 'The harness did not provide a distinct loopback cross-origin alias');
    }

    rec.expect('origin/origins-distinct', distinctOrigins, { origin, crossOrigin });
    rec.expect(
      'origin/same-origin-repeatable',
      primaryFirst.canvasDigest === primarySecond.canvasDigest &&
        primaryFirst.audioDigest === primarySecond.audioDigest,
      {
        canvas: [primaryFirst.canvasDigest, primarySecond.canvasDigest],
        audio: [primaryFirst.audioDigest, primarySecond.audioDigest]
      }
    );
    rec.expect(
      'origin/same-origin-page-stable',
      primaryOtherPage !== null && primaryOtherPage.canvasDigest === primaryFirst.canvasDigest,
      { pageOne: primaryFirst.canvasDigest, pageTwo: primaryOtherPage?.canvasDigest ?? null }
    );

    if (!crossFirst || !crossSecond) {
      rec.unknown('origin/cross-origin-repeatable', 'cross-origin alias unavailable');
      rec.unknown('origin/cross-origin-differs', 'cross-origin alias unavailable');
      rec.unknown('origin/audio-cross-origin-differs', 'cross-origin alias unavailable');
    } else {
      rec.expect(
        'origin/cross-origin-repeatable',
        crossFirst.canvasDigest === crossSecond.canvasDigest &&
          crossFirst.audioDigest === crossSecond.audioDigest,
        { canvas: [crossFirst.canvasDigest, crossSecond.canvasDigest], audio: [crossFirst.audioDigest, crossSecond.audioDigest] }
      );
      if (crossFirst.canvasDigest === primaryFirst.canvasDigest) {
        rec.unknown('origin/cross-origin-differs', {
          primary: primaryFirst.canvasDigest,
          cross: crossFirst.canvasDigest,
          reason: 'identical across loopback origins; scoping by origin not observed'
        });
        rec.limit('canvas-not-origin-scoped', 'Canvas perturbation is identical across loopback origins');
      } else {
        rec.expect('origin/cross-origin-differs', true, {
          primary: primaryFirst.canvasDigest,
          cross: crossFirst.canvasDigest
        });
      }
      if (primaryFirst.audioDigest === null || crossFirst.audioDigest === null) {
        rec.unknown('origin/audio-cross-origin-differs', primaryFirst.audioError ?? crossFirst.audioError);
        rec.limit('offline-audio-unavailable', primaryFirst.audioError ?? crossFirst.audioError ?? 'no audio digest');
      } else if (crossFirst.audioDigest === primaryFirst.audioDigest) {
        rec.unknown('origin/audio-cross-origin-differs', {
          primary: primaryFirst.audioDigest,
          cross: crossFirst.audioDigest,
          reason: 'identical across loopback origins; scoping by origin not observed'
        });
        rec.limit('audio-not-origin-scoped', 'Audio perturbation is identical across loopback origins');
      } else {
        rec.expect('origin/audio-cross-origin-differs', true, {
          primary: primaryFirst.audioDigest,
          cross: crossFirst.audioDigest
        });
      }
    }

    return finish(rec, {
      origin,
      crossOrigin,
      primary: { first: primaryFirst, second: primarySecond, otherPage: primaryOtherPage },
      cross: { first: crossFirst, second: crossSecond }
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
