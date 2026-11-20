// Speech synthesis voice inventory.
//
// Reads `getVoices()` and, when the engine populates asynchronously, waits for the
// `voiceschanged` event with a bound. No utterance is spoken. An empty inventory
// is a coverage gap: minimal Linux images legitimately ship no voices.

import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'speech-voices',
  family: 'api',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none (no utterance is spoken)',
    viewport: 'any',
    notes: 'Event-driven wait for voiceschanged, 3s bound. Never calls speak().',
    checks: [
      'speech/api-present',
      'speech/voices-populated',
      'speech/voice-fields-valid',
      'speech/deterministic',
      'speech/default-unique',
      'speech/voice-uri-unique',
      'speech/idle'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      const synthesis = window.speechSynthesis;
      if (!synthesis || typeof synthesis.getVoices !== 'function') return { present: false };
      const describe = (voice) => ({
        name: voice.name,
        lang: voice.lang,
        localService: voice.localService,
        default: voice.default,
        voiceURI: voice.voiceURI
      });
      let voices = [...synthesis.getVoices()];
      let waited = false;
      if (voices.length === 0) {
        waited = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          synthesis.addEventListener(
            'voiceschanged',
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true }
          );
        });
        voices = [...synthesis.getVoices()];
      }
      const first = voices.map(describe);
      const second = [...synthesis.getVoices()].map(describe);
      return {
        present: true,
        waited,
        first,
        second,
        speaking: synthesis.speaking,
        pending: synthesis.pending,
        paused: synthesis.paused
      };
    });

    if (!observed.present) {
      rec.unknown('speech/api-present', 'speechSynthesis absent');
      for (const name of [
        'speech/voices-populated',
        'speech/voice-fields-valid',
        'speech/deterministic',
        'speech/default-unique',
        'speech/voice-uri-unique',
        'speech/idle'
      ]) {
        rec.unknown(name, 'speechSynthesis absent');
      }
      rec.limit('speech-api-absent', 'window.speechSynthesis is not exposed');
      return finish(rec, observed);
    }

    rec.expect('speech/api-present', true);
    if (observed.first.length === 0) {
      rec.unknown('speech/voices-populated', { waited: observed.waited });
      rec.unknown('speech/voice-fields-valid', 'no voices');
      rec.unknown('speech/default-unique', 'no voices');
      rec.unknown('speech/voice-uri-unique', 'no voices');
      rec.limit('speech-voices-empty', 'The host exposes no speech voices');
    } else {
      rec.expect('speech/voices-populated', true, { count: observed.first.length, waited: observed.waited });
      rec.expect(
        'speech/voice-fields-valid',
        observed.first.every(
          (voice) =>
            typeof voice.name === 'string' &&
            voice.name.length > 0 &&
            typeof voice.lang === 'string' &&
            /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(voice.lang)
        ),
        observed.first
      );
      const defaults = observed.first.filter((voice) => voice.default === true).length;
      if (defaults === 0) {
        rec.unknown('speech/default-unique', 'no voice is marked default');
      } else {
        rec.expect('speech/default-unique', defaults === 1, { defaults });
      }
      const uris = new Set(observed.first.map((voice) => voice.voiceURI));
      rec.expect('speech/voice-uri-unique', uris.size === observed.first.length, { unique: uris.size });
    }
    rec.expect('speech/deterministic', JSON.stringify(observed.first) === JSON.stringify(observed.second));
    rec.expect('speech/idle', observed.speaking === false && observed.paused === false, {
      speaking: observed.speaking,
      paused: observed.paused,
      pending: observed.pending
    });

    return finish(rec, {
      waited: observed.waited,
      voices: observed.first,
      count: observed.first.length,
      speaking: observed.speaking
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
