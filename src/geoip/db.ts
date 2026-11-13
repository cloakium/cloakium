/**
 * GeoIP database access. The database is user-supplied; this module only reads
 * it. `mmdb-lib` is an optional peer dependency, loaded lazily.
 */

import fs from "node:fs";

import { GeoipLookupError, GeoipUnavailableError } from "../errors.js";
import { localeForCountry } from "./countries.js";

export const GEOIP_DB_ENV_VARS = ["CLOAKIUM_GEOIP_DB", "CLOAKBROWSER_GEOIP_DB"] as const;

const importOptional = (specifier: string): Promise<any> => import(specifier);

export interface GeoLookup {
  timezone?: string;
  locale?: string;
  country?: string;
}

export type Lookup = (ip: string) => GeoLookup;

/** Configured database path, or `undefined` when none is set. */
export function geoipDbPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of GEOIP_DB_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

let cached: { path: string; lookup: Lookup } | null = null;

function unavailable(detail: string): GeoipUnavailableError {
  return new GeoipUnavailableError(
    `[cloakium] geoip was requested but no usable GeoIP database is configured (${detail}). ` +
      "Provide CLOAKIUM_GEOIP_DB pointing at a MaxMind GeoLite2/GeoIP2 database and install " +
      "the optional `mmdb-lib` peer, pass a `geoipResolver` option, or set geoip: false. " +
      "cloakium never downloads the database.",
  );
}

/**
 * Load a lookup function backed by `CLOAKIUM_GEOIP_DB`.
 * Throws `GeoipUnavailableError` for every configuration problem.
 */
export async function loadGeoLookup(env: NodeJS.ProcessEnv = process.env): Promise<Lookup> {
  const dbPath = geoipDbPath(env);
  if (dbPath === undefined) throw unavailable("CLOAKIUM_GEOIP_DB is not set");

  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {
    throw unavailable(`database file ${dbPath} does not exist`);
  }
  if (size === 0) throw unavailable(`database file ${dbPath} is empty`);

  let Reader: any;
  try {
    const mod = await importOptional("mmdb-lib");
    Reader = mod.Reader ?? mod.default?.Reader;
  } catch {
    throw unavailable("the optional `mmdb-lib` peer is not installed");
  }
  if (typeof Reader !== "function") {
    throw unavailable("the installed `mmdb-lib` does not export a Reader");
  }

  if (cached?.path === dbPath) return cached.lookup;

  const buffer = fs.readFileSync(dbPath);
  let reader: any;
  try {
    reader = new Reader(buffer);
  } catch (error) {
    throw new GeoipLookupError(
      `[cloakium] ${dbPath} is not a readable MaxMind database: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lookup: Lookup = (ip: string) => {
    const record = reader.get(ip) as
      | { country?: { iso_code?: string }; location?: { time_zone?: string } }
      | null;
    const country = record?.country?.iso_code ?? undefined;
    return {
      timezone: record?.location?.time_zone ?? undefined,
      locale: localeForCountry(country),
      country,
    };
  };

  cached = { path: dbPath, lookup };
  return lookup;
}
