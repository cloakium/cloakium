import { probes } from "./request-paths.mjs";

export { probes };

export const probeIds = probes.map((probe) => probe.id);

export function findProbe(id) {
  return probes.find((probe) => probe.id === id) ?? null;
}
