import path from "node:path";
import { sourceManifest, hashValue } from "./hashes.mjs";
import { loadSuite } from "./suites.mjs";
import { observationId } from "./protocol.mjs";

export async function configurationSelections(configuration) {
  const suites = [];
  const seenProbes = new Set();
  const seenScenarios = new Set();
  for (const id of configuration.suites) {
    const suite = await loadSuite(id);
    const available = suite.kind === "profile" ? suite.scenarioIds : suite.probeIds;
    const probeIds = configuration.probeIds?.filter(value => available.includes(value));
    const scenarioIds = configuration.scenarioIds?.filter(value => suite.scenarioIds.includes(value));
    for (const value of probeIds ?? []) seenProbes.add(value);
    for (const value of scenarioIds ?? []) seenScenarios.add(value);
    const selected = configuration.probeIds === undefined || probeIds.length > 0;
    const scenarioSelected = configuration.scenarioIds === undefined || suite.kind === "probes" || scenarioIds.length > 0;
    if (!selected || !scenarioSelected) continue;
    const groups = suite.kind === "probes" ? [null] : scenarioIds ?? suite.scenarioIds;
    const rows = [];
    for (const scenarioId of groups) {
      const ids = suite.kind === "profile" ? [scenarioId] : suite.kind === "probes" ? available
        : suite.scenarioLaunch(scenarioId, {}).probes;
      for (const probeId of ids.filter(value => !probeIds || probeIds.includes(value))) {
        const descriptor = suite.probes.find(value => value.id === probeId);
        rows.push({ suiteId: id, scenarioId, id: probeId, family: descriptor?.family ?? "profile-lifecycle" });
      }
    }
    suites.push({ id, kind: suite.kind, ...(probeIds ? { probeIds } : {}),
      ...(suite.kind !== "probes" && scenarioIds ? { scenarioIds } : {}), rows });
  }
  if (configuration.probeIds?.some(value => !seenProbes.has(value)) ||
      configuration.scenarioIds?.some(value => !seenScenarios.has(value)))
    throw new Error("A configuration selected an unregistered probe or scenario");
  if (!suites.length || suites.some(suite => !suite.rows.length)) throw new Error("Audit selection produced no executable probes");
  return suites;
}

export async function suiteManifest(root, selections) {
  const source = await sourceManifest(root, { allFiles: true });
  const probes = new Map();
  const suiteSources = new Map();
  for (const selection of selections.flat())
    if (!suiteSources.has(selection.id))
      suiteSources.set(selection.id, await sourceManifest(path.join(root, selection.id), { allFiles: true }));
  for (const row of selections.flatMap(value => value.flatMap(suite => suite.rows))) {
    const id = observationId(row);
    probes.set(id, { id, sha256: hashValue({
      id, suiteSourceSha256: suiteSources.get(row.suiteId).sha256, sharedSourceSha256: source.sha256,
    }) });
  }
  return { source, probes: [...probes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
