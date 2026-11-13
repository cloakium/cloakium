/**
 * Optional GeoIP resolution: proxy egress → country → timezone/locale.
 *
 * Two supported sources, both explicit:
 *   - a caller-supplied `geoipResolver`;
 *   - a MaxMind database at `CLOAKIUM_GEOIP_DB` read with `mmdb-lib`.
 *
 * There is no database download and no bundled data. When neither source is
 * available the request fails with an actionable error instead of silently
 * launching with mismatched signals.
 */

import { GeoipLookupError } from "../errors.js";
import { parseProxy, proxySecrets } from "../proxy.js";
import { scrubError } from "../redact.js";
import type { ProxyConfigInput } from "../types.js";
import { loadGeoLookup } from "./db.js";
import { resolveEgressIp } from "./egress.js";

export { GEOIP_DB_ENV_VARS } from "./db.js";
export { isPrivateIp, resolveEgressIp } from "./egress.js";
export { COUNTRY_LOCALES, localeForCountry } from "./countries.js";

export interface GeoResolution {
  timezone?: string;
  locale?: string;
  ip?: string;
  country?: string;
}

export type GeoResolver = (
  input: { proxy?: string | ProxyConfigInput },
) => Promise<GeoResolution | null> | GeoResolution | null;

export interface GeoipOptions {
  /** Enable GeoIP-derived signals. */
  geoip?: boolean;
  /** Caller implementation; replaces the database lookup entirely. */
  geoipResolver?: GeoResolver;
  /** Proxy used to discover the egress address. */
  proxy?: string | ProxyConfigInput;
  /** Explicit values always win over resolved ones. */
  timezone?: string;
  locale?: string;
}

const TIMEOUT_ENV_VARS = ["CLOAKIUM_GEOIP_TIMEOUT_MS", "CLOAKBROWSER_GEOIP_TIMEOUT_MS"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

function timeoutMs(env: NodeJS.ProcessEnv): number {
  for (const name of TIMEOUT_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.length === 0) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.min(value, 60_000);
    throw new GeoipLookupError(`[cloakium] ${name}=${JSON.stringify(raw)} is not a positive number`);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve timezone/locale for a launch. Returns `{}` when `geoip` is off, and
 * only ever returns fields the caller or a resolver/database actually supplied.
 */
export async function maybeResolveGeoip(
  options: GeoipOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ timezone?: string; locale?: string }> {
  if (options.geoip !== true) return {};

  let resolved: GeoResolution = {};

  if (options.geoipResolver) {
    let result: GeoResolution | null;
    try {
      result = await options.geoipResolver({ proxy: options.proxy });
    } catch (error) {
      throw scrubError(error, proxySecrets(options.proxy));
    }
    if (result === null || result === undefined) {
      throw new GeoipLookupError(
        "[cloakium] geoipResolver returned no resolution; it must return at least a timezone or locale",
      );
    }
    resolved = result;
  } else if (options.timezone === undefined && options.locale === undefined) {
    const lookup = await loadGeoLookup(env);
    const proxy = parseProxy(options.proxy);
    const ip = await resolveEgressIp(proxy, timeoutMs(env), env);
    const record = lookup(ip);
    resolved = { ...record, ip };
    if (record.timezone === undefined && record.locale === undefined) {
      throw new GeoipLookupError(
        `[cloakium] the GeoIP database has no timezone or country for ${ip}`,
      );
    }
  }

  const timezone = options.timezone ?? resolved.timezone;
  const locale = options.locale ?? resolved.locale;
  if (timezone === undefined && locale === undefined) {
    throw new GeoipLookupError(
      "[cloakium] geoip produced neither a timezone nor a locale; pass explicit " +
        "`timezone`/`locale` options or set geoip: false",
    );
  }
  return {
    ...(timezone !== undefined ? { timezone } : {}),
    ...(locale !== undefined ? { locale } : {}),
  };
}
