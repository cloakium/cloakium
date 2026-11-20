/**
 * Request-path egress probes (taxonomy E15).
 *
 * Contract: `probes` items are `{ id, family, timeoutMs, run({ page, context,
 * browser, origin, crossOrigin, lab, config, deadline }) }` and every run returns
 * `{ observations, checks: [{ name, passed: true|false|null }], limitations }`.
 *
 * This suite exports `scenarioLaunch`/`configForScenario`, so a network-style
 * runner selects one scenario per browser process.
 */

export const PROBE_CONTRACT_VERSION = "cloakium-behavior-probes/request-paths@1";

export { startLab, requestPathEndpoints } from "./lab.mjs";
export { probes, probeIds, findProbe } from "./probes/index.mjs";
export { scenarios, scenarioForProbe, scenarioLaunch, configForScenario } from "./scenarios.mjs";
export { STATUS } from "./probes/kit.mjs";
