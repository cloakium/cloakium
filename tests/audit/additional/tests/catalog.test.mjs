import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probes } from "../index.mjs";

const catalog = JSON.parse(readFileSync(new URL("../../catalog/sources.json", import.meta.url), "utf8"));
const docs = readFileSync(new URL("../../../../docs/browser-audits/sources.md", import.meta.url), "utf8");
const EXPECTED_SOURCES = ["brave", "cromite", "helium", "librewolf", "mullvad-browser", "thorium", "ungoogled-chromium", "vanadium"];

test("catalog uses the declared schema and retrieval timestamp", () => {
  assert.equal(catalog.schema, "cloakium.audit.sources/1");
  assert.ok(!Number.isNaN(Date.parse(catalog.retrievedAt)));
  assert.ok(Array.isArray(catalog.sources));
  assert.deepEqual(catalog.sources.map((source) => source.id).sort(), EXPECTED_SOURCES);
  assert.equal(new Set(catalog.sources.map((source) => source.id)).size, catalog.sources.length);
});

test("every source pins identity, engine, license and availability axes", () => {
  for (const source of catalog.sources) {
    assert.match(source.commit, /^[0-9a-f]{40}$/, `${source.id} commit`);
    assert.ok(source.repository.startsWith("https://"), `${source.id} repository`);
    assert.equal(typeof source.engine.version, "string");
    assert.ok(source.engine.version.length > 0);
    assert.ok(["chromium", "gecko"].includes(source.engine.family));
    assert.ok(Array.isArray(source.platforms) && source.platforms.length > 0);
    assert.equal(typeof source.headless.status, "string");
    assert.equal(typeof source.playwright.status, "string");
    assert.ok(["osi-approved", "mixed-osi-with-exceptions"].includes(source.license.status));
    assert.ok(source.license.spdx.length > 0);
    assert.ok(source.license.proofUrl.startsWith("https://"));
    assert.ok(source.release.tag.length > 0 && source.release.url.startsWith("https://"));
    assert.ok(["not-executed", "not-runnable-on-linux", "out-of-scope-non-chromium"].includes(source.executionStatus));
    assert.ok(source.reason.length > 0);
  }
});

test("feature claims carry real evidence and no placeholders", () => {
  for (const source of catalog.sources) {
    assert.ok(source.features.length > 0, `${source.id} features`);
    const ids = new Set();
    for (const feature of source.features) {
      assert.match(feature.id, /^[a-z0-9.-]+$/, `${source.id} feature id`);
      assert.ok(!ids.has(feature.id), `${source.id} duplicate ${feature.id}`);
      ids.add(feature.id);
      assert.ok(feature.claim.length > 20, `${source.id}/${feature.id} claim`);
      assert.ok(Array.isArray(feature.evidence) && feature.evidence.length > 0);
      for (const evidence of feature.evidence) {
        assert.ok(evidence.url.startsWith("https://"), `${source.id}/${feature.id} evidence url`);
        assert.ok(!/PATCHES-NOT-USED|placeholder/i.test(evidence.url), `${source.id}/${feature.id} placeholder`);
        assert.equal(typeof evidence.kind, "string");
        if (evidence.commit !== null) assert.match(evidence.commit, /^[0-9a-f]{40}$/);
      }
    }
  }
  assert.ok(!JSON.stringify(catalog).includes("/home/stephenstubbs"), "catalog must not contain local paths");
});

test("documentation names every source and every additional probe", () => {
  for (const id of EXPECTED_SOURCES) assert.ok(docs.includes(`\`${id}\``), `docs omit ${id}`);
  for (const probe of probes) assert.ok(docs.includes(probe.id), `docs omit ${probe.id}`);
});
