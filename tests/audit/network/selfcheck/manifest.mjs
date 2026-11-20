/**
 * Registry validation for the network family. Builds the same machine-readable
 * description the harness consumes, then asserts it cannot drift: stable ids,
 * timeouts, one owning scenario per probe, resolvable fixture endpoints and a
 * tri-state-safe status vocabulary. Nothing is written to disk.
 */
import assert from "node:assert/strict";
import { probeIds, probes } from "../probes/index.mjs";
import { scenarioForProbe, scenarios } from "../scenarios.mjs";
import { STATUS } from "../probes/kit.mjs";

export const EXPECTED_PROBE_COUNT = 31;
export const EXPECTED_SCENARIO_COUNT = 17;

const failures = [];
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`FAIL ${name} :: ${error.message}\n`);
  }
}

// Endpoint names a requirement may reference, derived from the lab shape.
const LAB_ENDPOINTS = [
  "lab.origin", "lab.originStats", "lab.crossOrigin", "lab.port", "lab.tap", "lab.stun",
  "lab.dns", "lab.tls", "lab.http2", "lab.h3", "lab.doh", "lab.transparentProxy",
  "lab.proxy.http", "lab.proxy.httpAuth", "lab.proxy.socks5", "lab.proxy.socks5Auth",
];

export const manifest = {
  suite: "cloakium-independent-network-probes",
  descriptors: probes.map((probe) => ({
    id: probe.id,
    family: probe.family,
    stage: probe.stage,
    timeoutMs: probe.timeoutMs,
    contextOptions: probe.contextOptions,
    scenario: scenarioForProbe(probe.id)?.id ?? null,
    requirements: probe.requirements ?? null,
  })),
  scenarios: scenarios.map((scenario) => ({
    id: scenario.id,
    description: scenario.description,
    profileLifecycle: scenario.profileLifecycle,
    webrtcPolicy: scenario.webrtcPolicy ?? null,
    proxyEndpoint: scenario.proxyEndpoint ?? null,
    probes: [...scenario.probes],
  })),
};

check("probe and scenario counts are stable", () => {
  assert.equal(probes.length, EXPECTED_PROBE_COUNT, `probe count changed: ${probes.length}`);
  assert.equal(scenarios.length, EXPECTED_SCENARIO_COUNT, `scenario count changed: ${scenarios.length}`);
});

check("ids are unique and well-formed", () => {
  assert.equal(new Set(probeIds).size, probeIds.length);
  for (const probe of probes) assert.match(probe.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/);
});

check("every probe has a positive timeout within a sane ceiling", () => {
  for (const probe of probes) {
    assert.ok(Number.isInteger(probe.timeoutMs) && probe.timeoutMs > 0, `${probe.id}: timeoutMs`);
    assert.ok(probe.timeoutMs <= 60_000, `${probe.id}: timeoutMs above 60s`);
    assert.equal(typeof probe.contextOptions, "object", `${probe.id}: contextOptions`);
  }
});

check("every probe is assigned to a scenario", () => {
  for (const probe of probes) {
    const owners = scenarios.filter((scenario) => scenario.probes.includes(probe.id));
    assert.ok(owners.length >= 1, `${probe.id}: no owning scenario`);
  }
  for (const scenario of scenarios) {
    for (const id of scenario.probes) assert.ok(probeIds.includes(id), `${scenario.id}: unknown probe ${id}`);
  }
});

check("declared endpoints resolve to the lab shape", () => {
  for (const probe of probes) {
    for (const endpoint of probe.requirements?.endpoints ?? []) {
      // `lab.*` entries must name a fixture endpoint; anything else is a
      // capability label (a CDP method, an API surface) and is recorded as-is.
      if (endpoint.startsWith("lab.")) {
        assert.ok(LAB_ENDPOINTS.includes(endpoint), `${probe.id}: unknown endpoint ${endpoint}`);
      } else {
        assert.ok(endpoint.length > 0, `${probe.id}: empty capability label`);
      }
    }
  }
});

check("status vocabulary is tri-state safe", () => {
  const statuses = new Set(Object.values(STATUS));
  assert.equal(statuses.size, 6);
  for (const status of statuses) assert.match(status, /^(?:pass|fail|unavailable|stage-needed|unsupported-by-target|inconclusive)$/);
});

check("scenario launch plans are complete", () => {
  for (const scenario of scenarios) {
    assert.ok(Array.isArray(scenario.launch?.args), `${scenario.id}: launch.args`);
    assert.ok(Array.isArray(scenario.launch?.ignoreDefaultArgs), `${scenario.id}: ignoreDefaultArgs`);
    assert.ok(["none", "fresh-context", "caller-profile"].includes(scenario.profileLifecycle));
  }
});

process.stdout.write(
  `\nmanifest: ${manifest.descriptors.length} probes, ${manifest.scenarios.length} scenarios\n`,
);
if (failures.length) process.exitCode = 1;
