/**
 * `@cloakium/browser` — launch a patched Chromium through stock Playwright.
 *
 * The package owns option assembly, proxy normalisation, per-profile
 * fingerprint seeds, optional GeoIP resolution, and an opt-in humanize layer.
 * It never downloads a browser; the executable comes from the host.
 */

export {
  buildContextOptions,
  buildLaunchOptions,
  humanizeBrowser,
  launch,
  launchContext,
  launchPersistentContext,
  resolveTimezone,
} from "./launch.js";

export {
  BINARY_ENV_VARS,
  PATH_BINARY_NAME,
  resolveBinaryPath,
  tryResolveBinaryPath,
} from "./binary.js";

export {
  IGNORE_DEFAULT_ARGS,
  SEED_MAX,
  SEED_MIN,
  WRAPPER_VERSION,
  getDefaultStealthArgs,
  getPlatformTag,
} from "./config.js";

export {
  ensureProxyScheme,
  isSocksProxy,
  parseProxy,
  resolveProxyConfig,
} from "./proxy.js";
export type { ProxyConfig } from "./proxy.js";

export {
  LEGACY_SEED_FILE,
  SEED_FILE,
  applyProfileSeed,
  profileSeed,
  readSeedFile,
} from "./profile-seed.js";

export { maybeResolveGeoip, isPrivateIp, resolveEgressIp } from "./geoip/index.js";
export type { GeoResolution, GeoResolver, GeoipOptions } from "./geoip/index.js";

export {
  BinaryNotFoundError,
  CloakiumError,
  ConfigurationError,
  GeoipLookupError,
  GeoipUnavailableError,
  HumanizeCoveredError,
  HumanizeError,
  HumanizeTimeoutError,
  ProxyAuthUnsupportedError,
} from "./errors.js";

export type {
  LaunchContextOptions,
  LaunchOptions,
  LaunchPersistentContextOptions,
  ProxyConfigInput,
} from "./types.js";
