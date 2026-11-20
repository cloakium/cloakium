import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runAudit, sharedFixturePolicy } from "./runner.mjs";
import { additionalExecutableDigests, preflightPlan, targetDigests } from "./runner-preflight.mjs";
import { configurationSelections } from "./runner-manifest.mjs";

function plan() {
  return {
    schema: "cloakium.audit.plan/1", id: "fixture",
    environment: { id: "controlled", locale: "en-US", timezoneId: "UTC",
      display: { kind: "managed", width: 1920, height: 1080, depth: 24, dpi: 96, windowManager: "none" } },
    targets: [{ id: "baseline", label: "Fixture", artifactPath: process.execPath,
      executablePath: process.execPath, clientModule: "/fixture/index.mjs", layer: "engine", identity: "native", args: [] }],
    configurations: [{ id: "baseline-headless-1", targetId: "baseline", mode: "headless", iteration: 1,
      profileId: "native", args: [], contextOptions: {}, suites: ["fingerprint"], probeIds: ["navigator-core"] }],
  };
}

test("plan preflight rejects secret, unsafe, unknown and invalid-locale inputs before execution", () => {
  assert.equal(preflightPlan(plan()).id, "fixture");
  for (const change of [
    value => { value.extra = true; },
    value => { value.environment.locale = "C.UTF-8"; },
    value => { value.configurations[0].args = ["--no-sandbox"]; },
    value => { value.configurations[0].probeConfig = { password: "fixture-secret" }; },
    value => { value.targets[0].args = ["--proxy-server=http://fixture:secret@localhost:1"]; },
  ]) {
    const value = plan();
    change(value);
    assert.throws(() => preflightPlan(value));
  }
});

test("selected native ELF is identified without running it; a data file is refused", async () => {
  const first = await targetDigests(plan().targets);
  assert.equal(first[0].artifact.kind, "elf");
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-preflight-");
  try {
    const file = path.join(root, "fixture.txt");
    await fs.writeFile(file, "not an executable", { mode: 0o600 });
    await assert.rejects(targetDigests([{ id: "fixture", artifactPath: file, executablePath: process.execPath }]), /executable/);
    const wrapper = path.join(root, "wrapper");
    await fs.writeFile(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const value = plan();
    value.configurations[0].probeConfig = { provenanceFiles: [wrapper] };
    assert.equal((await additionalExecutableDigests(value))[0].kind, "script");
    value.configurations[0].probeConfig.provenanceFiles = [file];
    await assert.rejects(additionalExecutableDigests(value), /executable/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("selectors are distributed by suite without treating unrelated probe ids as unknown", async () => {
  const configuration = { suites: ["fingerprint", "browser-contracts"],
    probeIds: ["navigator-core", "native-property-contract"] };
  const selected = await configurationSelections(configuration);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(value => value.rows.length), [1, 1]);
  await assert.rejects(configurationSelections({ ...configuration, probeIds: ["not-registered"] }), /unregistered/);
});

test("whole-plan runner writes a strict fragment, private progress and provenance without a browser", async () => {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-runner-unit-");
  let released = 0;
  const source = { sha256: "a".repeat(64), files: [] };
  try {
    const file = path.join(root, "plan.json");
    const output = path.join(root, "output");
    await fs.writeFile(file, JSON.stringify(plan()), { mode: 0o600 });
    const metadata = { version: "1.0.0-fixture", path: "/fixture/index.mjs", sha256: "b".repeat(64),
      packageSha256: "c".repeat(64), patchManifestSha256: null };
    const dependencies = {
      acquireSeat: async () => ({ release: async () => { released++; } }),
      targetDigests: async () => [],
      loadDriver: async () => ({ chromium: {}, metadata }),
      fontInventory: async () => ({ status: "unavailable", files: [], sha256: null }),
      suiteManifest: async () => ({ source, probes: [{ id: "fingerprint.default.navigator-core", sha256: source.sha256 }] }),
      archiveSources: async () => ({ directory: "/fixture/source-snapshot/tests/audit",
        sha256: source.sha256, files: 0, verified: true }),
      sourceManifest: async () => source,
      createDisplayManager: () => ({ get: async mode => { assert.equal(mode, "headless"); return null; }, close: async () => ({ closed: true }) }),
      startSharedProbeFixture: async () => ({
        origin: "http://127.0.0.1:1234", crossOrigin: "http://127.0.0.2:1234", port: 1234,
        receipt: { origin: "http://127.0.0.1:1234" },
        close: async () => ({ closed: true }) }),
      executeSuite: async options => {
        assert.equal(Object.hasOwn(options.launchEnv, "DISPLAY"), false);
        const row = { id: "navigator-core", suiteId: "fingerprint", scenarioId: null, family: "navigator",
          status: "observed-inconsistency",
          result: { observations: { native: true }, checks: [{ name: "fixture-requirement", passed: false }], limitations: [] } };
        await options.onObservation(row);
        return { observations: [row], sessions: [{ version: "fixture-browser", diagnostics: { fixture: {
          origin: "http://127.0.0.1:1234", crossOrigin: "http://127.0.0.2:1234", port: 1234,
          ownership: "borrowed-owned-runner",
        } } }], errors: [], cleanup: { closed: true }, aborted: false };
      },
    };
    const result = await runAudit({ plan: file, output }, dependencies);
    assert.equal(result.complete, true);
    assert.equal(result.errors, 0);
    assert.equal(released, 1);
    const fragment = JSON.parse(await fs.readFile(path.join(output, "runner-report.json"), "utf8"));
    assert.equal(fragment.schema, "cloakium.audit.runner/1");
    assert.equal(fragment.runs[0].observations[0].result.checks[0].status, "fail");
    assert.equal(Object.hasOwn(fragment.runs[0].client, "patchManifestSha256"), false);
    assert.equal((await fs.stat(path.join(output, "runner-report.json"))).mode & 0o777, 0o600);
    await assert.rejects(runAudit({ plan: file, output }, dependencies), /existing output/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("one shared origin policy applies across all selected probe configurations", () => {
  const value = { configurations: [
    { suiteOptions: { sharedFixture: { port: 12345 } } },
    { suiteOptions: { sharedFixture: { port: 12345 } } },
  ] };
  const selections = [[{ kind: "probes" }], [{ kind: "probes" }]];
  assert.deepEqual(sharedFixturePolicy(value, selections), { port: 12345 });
  value.configurations[1].suiteOptions.sharedFixture.port = 12346;
  assert.throws(() => sharedFixturePolicy(value, selections), /same fixture/);
  value.configurations[1].suiteOptions.sharedFixture = { port: 12345, host: "remote.invalid" };
  assert.throws(() => sharedFixturePolicy(value, selections), /loopback/);
});
