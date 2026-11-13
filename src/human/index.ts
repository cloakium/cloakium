/**
 * Humanize subpath (`@cloakium/browser/human`).
 *
 * `patchPage` / `patchContext` / `patchBrowser` install the wrappers;
 * `resolveConfig` / `mergeConfig` produce a validated configuration. All of them
 * operate on public Playwright objects only.
 */

export { patchPage, patchContext, patchBrowser } from "./patch.js";
export {
  mergeConfig,
  presets,
  resolveConfig,
  validateHumanConfig,
} from "./config.js";
export type { HumanConfig, HumanPreset } from "./config.js";
export { HumanizeCoveredError, HumanizeError, HumanizeTimeoutError } from "../errors.js";
