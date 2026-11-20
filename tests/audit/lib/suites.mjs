// Suite registry: a literal whitelist of audit suites, loaded on demand.
//
// Only names in `knownSuites` can be loaded, so a suite id can never become a
// path into the repository. Each loaded suite is normalised to one descriptor
// shape; manifests, hashes and strict report DTOs are owned by the parent main.

const LOADERS = {
  fingerprint: () => import('../fingerprint/index.mjs'),
  'wire-identity': () => import('../wire-identity/index.mjs'),
  'browser-contracts': () => import('../browser-contracts/index.mjs'),
  additional: () => import('../additional/index.mjs'),
  network: () => import('../network/index.mjs'),
  'request-paths': () => import('../request-paths/index.mjs'),
  'extended-network': () => import('../extended-network/index.mjs'),
  'profile-lifecycle': () => import('../profile-lifecycle/index.mjs')
};

export const knownSuites = Object.freeze(Object.keys(LOADERS));

export const SUITE_TRANSPORTS = Object.freeze({
  'profile-lifecycle': 'playwright-persistent-context',
  default: 'playwright-browser-server'
});

function scenarioIdsOf(module) {
  if (Array.isArray(module.scenarioIds)) return [...module.scenarioIds];
  if (Array.isArray(module.scenarios)) return module.scenarios.map((scenario) => scenario.id);
  return [];
}

function normalise(id, module) {
  const probes = Array.isArray(module.probes) ? [...module.probes] : [];
  const probeIds = probes.map((probe) => probe.id);
  if (new Set(probeIds).size !== probeIds.length) throw new Error(`Suite ${id} has duplicate probe ids`);
  for (const probe of probes) {
    if (typeof probe.id !== 'string' || typeof probe.run !== 'function') {
      throw new Error(`Suite ${id} has a malformed probe descriptor`);
    }
  }
  const scenarioIds = scenarioIdsOf(module);
  const kind = id === 'profile-lifecycle' ? 'profile' : scenarioIds.length ? 'scenarios' : 'probes';
  const descriptor = {
    id,
    kind,
    transport: SUITE_TRANSPORTS[id] ?? SUITE_TRANSPORTS.default,
    probes,
    probeIds,
    scenarioIds,
    scenarios: Array.isArray(module.scenarios) ? [...module.scenarios] : null,
    scenarioLaunch: typeof module.scenarioLaunch === 'function' ? module.scenarioLaunch : null,
    configForScenario: typeof module.configForScenario === 'function' ? module.configForScenario : null,
    findProbe: typeof module.findProbe === 'function' ? module.findProbe : null,
    startLab: typeof module.startLab === 'function' ? module.startLab : null,
    runScenarios: typeof module.runScenarios === 'function' ? module.runScenarios : null,
    validateProbes: typeof module.validateProbes === 'function' ? module.validateProbes : null
  };
  if (descriptor.validateProbes) descriptor.validateProbes();
  if (kind === 'scenarios' && (!descriptor.scenarioLaunch || !descriptor.configForScenario)) {
    throw new Error(`Suite ${id} declares scenarios without launch/config resolution`);
  }
  if (kind === 'profile' && !descriptor.runScenarios) {
    throw new Error('profile-lifecycle must export runScenarios');
  }
  return descriptor;
}

const cache = new Map();

export async function loadSuite(id) {
  if (!Object.hasOwn(LOADERS, id)) throw new Error(`Unknown audit suite: ${id}`);
  if (!cache.has(id)) cache.set(id, normalise(id, await LOADERS[id]()));
  return cache.get(id);
}

/**
 * List the selectors a suite actually registers, without launching anything.
 * Unknown suite or selector ids are rejected rather than silently returning [].
 */
export async function enumerateSuite(id, probeIds = undefined) {
  const suite = await loadSuite(id);
  const known = new Set([...suite.probeIds, ...suite.scenarioIds]);
  if (probeIds !== undefined) {
    if (!Array.isArray(probeIds) || probeIds.length === 0) {
      throw new Error(`enumerateSuite(${id}): probeIds must be a non-empty array`);
    }
    const unknown = probeIds.filter((probeId) => !known.has(probeId));
    if (unknown.length) throw new Error(`enumerateSuite(${id}): unknown id(s) ${unknown.join(', ')}`);
  }
  return {
    suiteId: id,
    kind: suite.kind,
    transport: suite.transport,
    probeIds: probeIds ? [...probeIds] : [...suite.probeIds],
    scenarioIds: [...suite.scenarioIds]
  };
}
