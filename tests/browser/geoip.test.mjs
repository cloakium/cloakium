/**
 * GeoIP: resolver contract and database validation. No browser, no network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GeoipLookupError,
  GeoipUnavailableError,
  maybeResolveGeoip,
} from "../../dist/index.js";
import { test } from "./harness.mjs";

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("geoip is a no-op when disabled", async () => {
  assert.deepEqual(await maybeResolveGeoip({ geoip: false }), {});
  assert.deepEqual(await maybeResolveGeoip({}), {});
});

test("a resolver can supply either signal", async () => {
  const onlyTimezone = await maybeResolveGeoip({
    geoip: true,
    geoipResolver: () => ({ timezone: "America/New_York" }),
  });
  assert.deepEqual(onlyTimezone, { timezone: "America/New_York" });

  const explicitLocale = await maybeResolveGeoip({
    geoip: true,
    locale: "en-GB",
    geoipResolver: () => ({ timezone: "Europe/London" }),
  });
  assert.deepEqual(explicitLocale, { timezone: "Europe/London", locale: "en-GB" });
});

test("a resolver that returns nothing is an error", async () => {
  await assert.rejects(
    () => maybeResolveGeoip({ geoip: true, geoipResolver: () => null }),
    (error) => error instanceof GeoipLookupError && /returned no resolution/.test(error.message),
  );
});

test("database mode rejects a missing, empty or foreign file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-geoip-"));
  const missing = path.join(directory, "missing.mmdb");
  const empty = path.join(directory, "empty.mmdb");
  const foreign = path.join(directory, "foreign.mmdb");
  fs.writeFileSync(empty, "");
  fs.writeFileSync(foreign, "not a database");

  await withEnv({ CLOAKIUM_GEOIP_DB: missing }, async () => {
    await assert.rejects(
      () => maybeResolveGeoip({ geoip: true }),
      (error) => error instanceof GeoipUnavailableError && /does not exist/.test(error.message),
    );
  });

  await withEnv({ CLOAKIUM_GEOIP_DB: empty }, async () => {
    await assert.rejects(
      () => maybeResolveGeoip({ geoip: true }),
      (error) => error instanceof GeoipUnavailableError && /is empty/.test(error.message),
    );
  });

  // mmdb-lib is an optional peer and is not installed in this repository, so a
  // real database file reaches the "install the peer" branch.
  await withEnv({ CLOAKIUM_GEOIP_DB: foreign }, async () => {
    await assert.rejects(
      () => maybeResolveGeoip({ geoip: true }),
      (error) =>
        error instanceof GeoipUnavailableError &&
        /mmdb-lib|not a readable MaxMind database/.test(error.message),
    );
  });
});

test("the legacy database variable is still accepted", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-geoip-legacy-"));
  const file = path.join(directory, "db.mmdb");
  fs.writeFileSync(file, "");
  await withEnv({ CLOAKIUM_GEOIP_DB: undefined, CLOAKBROWSER_GEOIP_DB: file }, async () => {
    await assert.rejects(
      () => maybeResolveGeoip({ geoip: true }),
      (error) => error instanceof GeoipUnavailableError && /is empty/.test(error.message),
    );
  });
});