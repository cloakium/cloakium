// Aggregate entry point for the additional audit probes.
//
// Descriptor: { id, family, timeoutMs, contextOptions?, run({ page, context,
// browser, origin, crossOrigin, config, deadline }) }.
// Result: { observations, checks: [{ name, passed, status }], limitations,
// coverage, failed } with `passed: null` meaning not evaluable.

import { probes as geometry } from "./geometry.mjs";
import { probes as locale } from "./locale.mjs";
import { probes as webgpuCompute } from "./webgpu-compute.mjs";
import { probes as webglStatus } from "./webgl-status.mjs";
import { probes as audioSignal } from "./audio-signal.mjs";
import { probes as inputPhysics } from "./input-physics.mjs";
import { probes as egress } from "./egress.mjs";
import { probes as permissions } from "./permissions.mjs";

export const MAX_TIMEOUT_MS = 45_000;

export const probes = [
  ...geometry,
  ...locale,
  ...webgpuCompute,
  ...webglStatus,
  ...audioSignal,
  ...inputPhysics,
  ...egress,
  ...permissions,
];

export const probeIds = probes.map((probe) => probe.id);
export const families = [...new Set(probes.map((probe) => probe.family))].sort();

const FORBIDDEN_KEYS = ["initScripts", "evaluateOnNewDocument", "nativePropertyOverrides", "injectScript"];

export function validateProbes(list = probes) {
  const ids = new Set();
  for (const probe of list) {
    if (typeof probe.id !== "string" || !/^[a-z0-9]+\/[a-z0-9-]+$/.test(probe.id)) {
      throw new Error(`invalid probe id: ${String(probe.id)}`);
    }
    if (ids.has(probe.id)) throw new Error(`duplicate probe id: ${probe.id}`);
    ids.add(probe.id);
    if (typeof probe.family !== "string" || probe.family.length === 0) throw new Error(`${probe.id}: family is required`);
    if (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs <= 0 || probe.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`${probe.id}: timeoutMs must be 1..${MAX_TIMEOUT_MS}`);
    }
    if (probe.contextOptions !== undefined && (typeof probe.contextOptions !== "object" || probe.contextOptions === null || Array.isArray(probe.contextOptions))) {
      throw new Error(`${probe.id}: contextOptions must be an object`);
    }
    if (typeof probe.run !== "function") throw new Error(`${probe.id}: run must be a function`);
    for (const key of FORBIDDEN_KEYS) {
      if (key in probe) throw new Error(`${probe.id}: ${key} is not allowed`);
    }
  }
  return { ids: [...ids], families: [...new Set(list.map((probe) => probe.family))].sort() };
}

export function findProbe(id) {
  return probes.find((probe) => probe.id === id) ?? null;
}
