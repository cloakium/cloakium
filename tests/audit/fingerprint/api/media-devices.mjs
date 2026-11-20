// Media devices and codec surface, without opening any device.
//
// `enumerateDevices()` is called twice; `getUserMedia()` is never called, so no
// permission prompt appears and no capture device is activated. Label privacy is
// recorded, not asserted, because a previously granted permission changes it.

import { finish, prepare, recorder } from '../support/common.mjs';

const CODECS = [
  'audio/mpeg',
  'audio/ogg; codecs="opus"',
  'audio/wav; codecs="1"',
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"'
];

const probe = {
  id: 'media-devices',
  family: 'api',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none (getUserMedia is never called)',
    viewport: 'any',
    notes: 'No device is opened and no permission is requested.',
    checks: [
      'media/enumerate-succeeds',
      'media/kinds-valid',
      'media/deterministic',
      'media/label-policy-stable',
      'media/device-ids-typed',
      'media/supported-constraints',
      'media/open-codecs-playable'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async (codecs) => {
      const devices = navigator.mediaDevices;
      if (!devices || typeof devices.enumerateDevices !== 'function') {
        return { present: false };
      }
      const describe = () => {
        try {
          return devices.enumerateDevices().then((list) =>
            list.map((device) => ({
              kind: device.kind,
              label: device.label,
              deviceIdType: typeof device.deviceId,
              deviceIdLength: typeof device.deviceId === 'string' ? device.deviceId.length : null,
              groupId: device.groupId
            }))
          );
        } catch (error) {
          return Promise.resolve({ error: error.name });
        }
      };
      const first = await describe();
      const second = await describe();
      const constraints =
        typeof devices.getSupportedConstraints === 'function'
          ? Object.keys(devices.getSupportedConstraints()).sort()
          : null;
      const element = document.createElement('video');
      const codecSupport = {};
      for (const type of codecs) codecSupport[type] = element.canPlayType(type);
      return {
        present: true,
        first,
        second,
        constraints,
        codecSupport,
        hasGetUserMedia: typeof devices.getUserMedia === 'function'
      };
    }, CODECS);

    if (!observed.present) {
      rec.unknown('media/enumerate-succeeds', 'navigator.mediaDevices absent');
      for (const name of [
        'media/kinds-valid',
        'media/deterministic',
        'media/label-policy-stable',
        'media/device-ids-typed',
        'media/supported-constraints',
        'media/open-codecs-playable'
      ]) {
        rec.unknown(name, 'navigator.mediaDevices absent');
      }
      rec.limit('media-devices-absent', 'navigator.mediaDevices is not exposed');
      return finish(rec, observed);
    }

    if (!Array.isArray(observed.first)) {
      rec.unknown('media/enumerate-succeeds', observed.first?.error ?? 'enumeration failed');
      for (const name of ['media/kinds-valid', 'media/deterministic', 'media/label-policy-stable', 'media/device-ids-typed']) {
        rec.unknown(name, 'enumeration failed');
      }
      rec.limit('media-enumeration-failed', observed.first?.error ?? 'enumerateDevices rejected');
    } else {
      rec.expect('media/enumerate-succeeds', true, { count: observed.first.length });
      rec.expect(
        'media/kinds-valid',
        observed.first.every((device) => ['audioinput', 'audiooutput', 'videoinput'].includes(device.kind))
      );
      rec.expect(
        'media/deterministic',
        JSON.stringify(observed.first.map(({ kind, label }) => ({ kind, label }))) ===
          JSON.stringify(observed.second.map(({ kind, label }) => ({ kind, label })))
      );
      const labels = observed.first.map((device) => device.label);
      const labelsEmpty = labels.every((label) => label === '');
      const labelsFull = labels.every((label) => typeof label === 'string' && label.length > 0);
      rec.expect(
        'media/label-policy-stable',
        labels.every((label) => typeof label === 'string') && (labelsEmpty || labelsFull),
        { labelsEmpty, labelsFull, count: labels.length }
      );
      rec.expect(
        'media/device-ids-typed',
        observed.first.every((device) => device.deviceIdType === 'string'),
        {
          emptyIds: observed.first.every((device) => device.deviceIdLength === 0)
        }
      );
    }

    if (!observed.constraints) {
      rec.unknown('media/supported-constraints', 'getSupportedConstraints absent');
    } else {
      rec.expect(
        'media/supported-constraints',
        ['deviceId', 'groupId', 'echoCancellation', 'frameRate', 'width', 'height'].every((key) =>
          observed.constraints.includes(key)
        ),
        observed.constraints
      );
    }

    const playable = Object.entries(observed.codecSupport)
      .filter(([, verdict]) => verdict === 'probably' || verdict === 'maybe')
      .map(([type]) => type);
    if (playable.length === 0) {
      rec.unknown('media/open-codecs-playable', observed.codecSupport);
      rec.limit('codecs-unavailable', 'No sampled codec is playable; proprietary and open codecs both absent');
    } else {
      rec.expect('media/open-codecs-playable', true, { playable });
    }

    return finish(rec, {
      devices: observed.first,
      constraints: observed.constraints,
      codecSupport: observed.codecSupport,
      playable
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
