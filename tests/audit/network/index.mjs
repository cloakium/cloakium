/** Barrel: the only import surface the parent harness needs. */

export const PROBE_CONTRACT_VERSION = "cloakium-behavior-probes/network@1";

export { startLab } from "./lab/index.mjs";
export { probes, probeIds, findProbe } from "./probes/index.mjs";
export { scenarios, scenarioForProbe, scenarioLaunch, configForScenario } from "./scenarios.mjs";
export { STATUS } from "./probes/kit.mjs";
