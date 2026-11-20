// Seed persistence, kept separate from build-owned profile state.
//
// The engine is tested only through an explicit master seed (documented flag).
// A root-level state file may be build-scoped, so its presence is recorded and
// never asserted. With no seed argument the scenario records the native identity
// and asserts only that it is stable across reopen and across profiles on the
// same host — it makes no native-persistence claim.

import { recorder, finish } from '../lib/recorder.mjs';
import { inspectProfile } from '../lib/profile.mjs';
import { flagName } from '../lib/flags.mjs';

const SEED_FLAG = '--fingerprint';
const PASSTHROUGH = new Set(['off', 'false', '0', 'disable', 'disabled']);

function seedFlags(args) {
  return args.filter((argument) => {
    if (flagName(argument) !== SEED_FLAG) return false;
    const value = String(argument).split('=')[1] ?? '';
    return !PASSTHROUGH.has(value.toLowerCase());
  });
}

async function readIdentity(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#336699';
    context.fillRect(0, 0, 32, 32);
    context.fillStyle = '#ffffff';
    context.font = '12px monospace';
    context.fillText('seed-probe', 2, 20);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    let hash = 0x811c9dc5;
    for (let index = 0; index < pixels.length; index++) hash = Math.imul(hash ^ pixels[index], 0x01000193) >>> 0;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      maxTouchPoints: navigator.maxTouchPoints,
      screen: [screen.width, screen.height],
      devicePixelRatio: window.devicePixelRatio,
      canvasDigest: hash.toString(16).padStart(8, '0')
    };
  });
}

function digestOf(identity) {
  return JSON.stringify(identity);
}

export const scenario = {
  id: 'seed-persistence',
  timeoutMs: 120_000,
  checks: [
    'seed/identity-stable-across-reopen',
    'seed/identity-stable-across-profiles',
    'seed/state-file-recorded'
  ],

  async run({ lab, server, baseArgs, options, log }) {
    const rec = recorder();
    const fromBase = seedFlags(baseArgs);
    const masterSeed = options.masterSeed ?? null;
    let extraArgs = [];
    let mode = 'seedless';
    if (fromBase.length > 0) {
      mode = 'base-args';
      if (masterSeed !== null) {
        rec.limit('master-seed-ignored-because-base-args-set', 'baseArgs already carry a seed; masterSeed was not appended');
      }
    } else if (masterSeed !== null) {
      mode = 'master-seed';
      extraArgs = [`${SEED_FLAG}=${masterSeed}`];
    } else {
      rec.limit(
        'no-documented-native-seed-file-contract',
        'No seed argument was supplied; native seed persistence is recorded, not asserted'
      );
    }

    const first = await lab.createProfile('seed-first');
    const firstOpen = await lab.open({ label: 'seed-first-write', directory: first, args: extraArgs });
    let firstIdentity;
    try {
      firstIdentity = await readIdentity(firstOpen.page, server.origin);
    } finally {
      await lab.close();
    }
    const firstProfile = await inspectProfile(first);

    const secondOpen = await lab.open({ label: 'seed-first-reopen', directory: first, args: extraArgs });
    let reopenIdentity;
    try {
      reopenIdentity = await readIdentity(secondOpen.page, server.origin);
    } finally {
      await lab.close();
    }

    const other = await lab.createProfile('seed-second');
    const otherOpen = await lab.open({ label: 'seed-second-write', directory: other, args: extraArgs });
    let otherIdentity;
    try {
      otherIdentity = await readIdentity(otherOpen.page, server.origin);
    } finally {
      await lab.close();
    }

    rec.expect(
      'seed/identity-stable-across-reopen',
      digestOf(firstIdentity) === digestOf(reopenIdentity),
      { first: firstIdentity, reopen: reopenIdentity }
    );
    rec.expect(
      'seed/identity-stable-across-profiles',
      digestOf(firstIdentity) === digestOf(otherIdentity),
      { first: firstIdentity, other: otherIdentity }
    );

    if (!firstProfile.stateFiles.present) {
      rec.unknown('seed/state-file-recorded', 'no engine state file at the profile root');
      rec.limit('engine-state-file-absent', 'A build need not write a root-level state file; absence is not a native defect');
    } else {
      rec.expect('seed/state-file-recorded', firstProfile.stateFiles.count > 0, {
        count: firstProfile.stateFiles.count,
        files: firstProfile.stateFiles.files
      });
      rec.limit('state-file-is-build-scoped', 'A root-level state file is recorded as build-owned state, not as native evidence');
    }

    log(`seed: mode=${mode} stableReopen=${digestOf(firstIdentity) === digestOf(reopenIdentity)}`);
    return finish(rec, {
      mode,
      extraArgs,
      baseArgsSeed: fromBase,
      firstIdentity,
      reopenIdentity,
      otherIdentity,
      stateFiles: firstProfile.stateFiles
    });
  }
};
