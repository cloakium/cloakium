// Aggregate entry point: every probe in one ordered array.
//
// Descriptor shape (normalised here, so modules stay declarative):
//   {
//     id, family, timeoutMs, budgetMs, contextOptions, contract,
//     async run({ page, context, browser, origin, crossOrigin, lab, config, deadline })
//   }
//
// `run` resolves to { observations, checks, limitations, coverage, failed } where
// a check's `passed` is true, false, or null (null = not evaluable, never a pass).
// Every run is hard-bounded by `timeoutMs`, or by `deadline` when the caller
// supplies an earlier wall-clock limit.

import { probes as navigatorCore } from './navigator/core.mjs';
import { probes as navigatorClientHints } from './navigator/client-hints.mjs';
import { probes as navigatorMediaQueries } from './navigator/media-queries.mjs';
import { probes as screenGeometry } from './screen/geometry.mjs';
import { probes as screenMultidisplay } from './screen/multidisplay.mjs';
import { probes as canvas2dReadback } from './render/canvas2d.mjs';
import { probes as canvas2dText } from './render/canvas2d-text.mjs';
import { probes as offscreenWorker } from './render/offscreen-worker.mjs';
import { probes as svgRaster } from './render/svg.mjs';
import { probes as webglSurface } from './render/webgl.mjs';
import { probes as webgpuAdapter } from './render/webgpu.mjs';
import { probes as audioOffline } from './render/audio-offline.mjs';
import { probes as audioWorklet } from './render/audio-worklet.mjs';
import { probes as mathNumeric } from './numeric/math.mjs';
import { probes as fontMetrics } from './text/font-metrics.mjs';
import { probes as systemColors } from './text/system-colors.mjs';
import { probes as speechVoices } from './api/speech-voices.mjs';
import { probes as mediaDevices } from './api/media-devices.mjs';
import { probes as apiDrm } from './api/drm.mjs';
import { probes as apiWebauthn } from './api/webauthn.mjs';
import { probes as apiCapabilityPresence } from './api/capability-presence.mjs';
import { probes as originScope } from './origin/origin-scope.mjs';

export const MAX_PROBE_TIMEOUT_MS = 20_000;

// Thrown when a probe runs out of its own budget or the caller's deadline. The
// harness should record this row as unknown/not-run, never as a check failure.
export class ProbeDeadlineError extends Error {
  constructor(id, ms) {
    super(`${id} exceeded its ${ms} ms budget`);
    this.name = 'ProbeDeadlineError';
    this.code = 'deadline-exceeded';
    this.probeId = id;
    this.budgetMs = ms;
  }
}

function requirementsFor(probe) {
  const contract = probe.contract ?? {};
  const endpoints = ['lab.origin'];
  if (contract.crossOrigin && contract.crossOrigin !== 'not-used') endpoints.push('lab.crossOrigin');
  return {
    endpoints,
    launchArgs: [],
    contextOptions: { ...(probe.contextOptions ?? {}) },
    profileLifecycle: 'fresh-context',
    relaunch: false,
    needs: contract.notes ?? 'a loopback origin serving a document at /'
  };
}

function normalise(probe) {
  const timeoutMs = probe.timeoutMs ?? probe.budgetMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROBE_TIMEOUT_MS) {
    throw new Error(`${probe.id}: timeoutMs must be an integer in 1..${MAX_PROBE_TIMEOUT_MS}`);
  }
  return {
    ...probe,
    timeoutMs,
    budgetMs: timeoutMs,
    contextOptions: { ...(probe.contextOptions ?? {}) },
    requirements: probe.requirements ?? requirementsFor(probe),
    run(args = {}) {
      const remaining =
        typeof args.deadline === 'number' && Number.isFinite(args.deadline)
          ? Math.max(0, args.deadline - Date.now())
          : timeoutMs;
      const budget = Math.min(timeoutMs, remaining);
      if (budget <= 0) return Promise.reject(new ProbeDeadlineError(probe.id, 0));
      let timer;
      return Promise.race([
        probe.run({ ...args, budgetMs: budget }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ProbeDeadlineError(probe.id, budget)), budget);
        })
      ]).finally(() => clearTimeout(timer));
    }
  };
}

export const probes = [
  ...navigatorCore,
  ...navigatorClientHints,
  ...navigatorMediaQueries,
  ...screenGeometry,
  ...screenMultidisplay,
  ...canvas2dReadback,
  ...canvas2dText,
  ...offscreenWorker,
  ...svgRaster,
  ...webglSurface,
  ...webgpuAdapter,
  ...audioOffline,
  ...audioWorklet,
  ...mathNumeric,
  ...fontMetrics,
  ...systemColors,
  ...speechVoices,
  ...mediaDevices,
  ...apiDrm,
  ...apiWebauthn,
  ...apiCapabilityPresence,
  ...originScope
].map(normalise);

export const families = [...new Set(probes.map((probe) => probe.family))].sort();
