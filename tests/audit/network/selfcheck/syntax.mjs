/**
 * Static validation of the probe + scenario contract. No browser, no runtime
 * claims: shape, exports, and degradation paths only.
 */
import assert from "node:assert/strict";
import { probes, probeIds, startLab, scenarios, scenarioForProbe, scenarioLaunch, configForScenario } from "../index.mjs";

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`FAIL ${name} :: ${error.message}\n`);
  }
};

const STATUSES = new Set(["pass", "fail", "unavailable", "stage-needed", "unsupported-by-target", "inconclusive"]);
const REQUIREMENT_KEYS = new Set([
  "endpoints",
  "launchArgs",
  "launchArgsAbsent",
  "launchProxy",
  "contextOptions",
  "profileLifecycle",
  "relaunch",
  "precondition",
  "needs",
]);
const PROFILE_LIFECYCLES = new Set(["none", "fresh-context", "caller-profile"]);

check("exports.startLab", () => assert.equal(typeof startLab, "function"));
check("probes.is-array", () => assert.ok(Array.isArray(probes) && probes.length > 0));
check("probes.ids-unique", () => assert.equal(new Set(probeIds).size, probeIds.length, "duplicate ids"));
check("probes.id-shape", () => {
  for (const probe of probes) assert.match(probe.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/, `bad id ${probe.id}`);
});
check("probes.stage-present", () => {
  for (const probe of probes) assert.ok(["runtime", "static"].includes(probe.stage), `bad stage on ${probe.id}`);
});
check("probes.run-is-async", () => {
  for (const probe of probes) assert.equal(probe.run?.constructor?.name, "AsyncFunction", `run not async on ${probe.id}`);
});
check("probes.requirements-object", () => {
  for (const probe of probes) {
    const requirements = probe.requirements;
    assert.ok(requirements && typeof requirements === "object" && !Array.isArray(requirements), `${probe.id} requirements must be an object`);
    for (const key of Object.keys(requirements)) assert.ok(REQUIREMENT_KEYS.has(key), `${probe.id} unknown requirement key ${key}`);
    assert.ok(Array.isArray(requirements.endpoints), `${probe.id} requirements.endpoints missing`);
    assert.ok(Array.isArray(requirements.launchArgs), `${probe.id} requirements.launchArgs missing`);
    assert.ok(PROFILE_LIFECYCLES.has(requirements.profileLifecycle), `${probe.id} bad profileLifecycle`);
    assert.equal(typeof requirements.relaunch, "boolean", `${probe.id} relaunch must be boolean`);
  }
});
check("scenarios.cover-every-probe", () => {
  for (const probe of probes) {
    assert.ok(scenarioForProbe(probe.id), `probe ${probe.id} is not assigned to a scenario`);
  }
});
check("scenarios.ids-unique", () => assert.equal(new Set(scenarios.map((entry) => entry.id)).size, scenarios.length, "duplicate scenario ids"));
check("scenarios.probe-ids-known", () => {
  for (const scenario of scenarios) {
    for (const id of scenario.probes) assert.ok(probeIds.includes(id), `${scenario.id} references unknown probe ${id}`);
  }
});
check("scenarios.launch-shape", () => {
  for (const scenario of scenarios) {
    assert.ok(Array.isArray(scenario.launch?.args), `${scenario.id} launch.args`);
    assert.ok(Array.isArray(scenario.launch?.ignoreDefaultArgs), `${scenario.id} ignoreDefaultArgs`);
    assert.ok(PROFILE_LIFECYCLES.has(scenario.profileLifecycle), `${scenario.id} bad profileLifecycle`);
  }
});

const fakePage = {
  goto: async () => ({ status: () => 200, text: async () => "{}" }),
  evaluate: async () => null,
  title: async () => "",
  setExtraHTTPHeaders: async () => {},
  reload: async () => {},
  close: async () => {},
  frames: () => [],
};
const fakeContext = {
  browser: () => null,
  newPage: async () => fakePage,
  newCDPSession: async () => {
    throw new Error("not available in syntax check");
  },
  addCookies: async () => {},
  cookies: async () => [],
  on() {},
  off() {},
};
const fakeLab = {
  origin: "http://127.0.0.1:1",
  crossOrigin: "http://[::1]:1",
  crossOriginMode: "ipv6-loopback-same-port",
  port: 1,
  proxy: {
    http: { url: "http://127.0.0.1:2", port: 2, stats: () => ({ absoluteRequests: 0, connects: 0, authOk: 0, rejectedAuth: 0, blockedExternal: 0, targets: [] }) },
    httpAuth: { url: "http://127.0.0.1:3", port: 3, credentials: { username: "u", password: "p" }, stats: () => ({ connects: 0, authOk: 0, rejectedAuth: 0, targets: [] }) },
    socks5: { url: "socks5://127.0.0.1:4", port: 4, stats: () => ({ connects: 0, udpAssociateRequests: 0, offeredMethods: {}, atypCounts: { domain: 0 }, targets: [], greetings: 0 }) },
    socks5Auth: { url: "socks5://127.0.0.1:5", port: 5, credentials: { username: "u", password: "p" }, stats: () => ({ greetings: 0, authOk: 0, authFail: 0, connects: 0, offeredMethods: {}, targets: [] }) },
  },
  stun: { url: "stun:127.0.0.1:6", stats: () => ({ requests: 0, responses: 0, sourcePorts: [], nonLoopbackSources: 0 }) },
  dns: { stats: () => ({ queries: [] }) },
  tap: { url: "https://localhost:7", port: 7, stats: () => ({ captured: 0, connections: 0, last: null }) },
  tls: { available: false, reason: "syntax check" },
  http2: { available: false, reason: "syntax check" },
  h3: { available: false, reason: "syntax check", buildHint: "none" },
  doh: { available: false, reason: "syntax check" },
  transparentProxy: { available: false, reason: "syntax check" },
  originStats: () => ({ hits: {}, requests: [] }),
};

check("scenarios.resolve-template", () => {
  const plan = scenarioLaunch("http-proxy", fakeLab);
  assert.ok(plan.launch.args.includes("--proxy-server=http://127.0.0.1:2"), `args=${plan.launch.args.join(" ")}`);
  assert.equal(plan.launch.proxy, null);
  const authed = scenarioLaunch("http-proxy-auth", fakeLab);
  assert.equal(authed.launch.proxy.server, "http://127.0.0.1:3");
  assert.equal(authed.launch.proxy.username, "u");
  const config = configForScenario(authed);
  assert.equal(config.proxy.mode, "process");
  assert.equal(config.proxy.endpoint, "lab.proxy.httpAuth");
  assert.equal(scenarioLaunch("default", fakeLab).launch.proxy, null);
  assert.equal(scenarioLaunch("nope", fakeLab), null);
});

for (const probe of probes) {
  const scenario = scenarioForProbe(probe.id);
  const plan = scenarioLaunch(scenario.id, fakeLab);
  const config = configForScenario(plan, { playwrightDefaults: true, trustLabCa: false });
  try {
    const output = await probe.run({
      page: fakePage,
      context: fakeContext,
      browser: null,
      origin: fakeLab.origin,
      crossOrigin: fakeLab.crossOrigin,
      lab: fakeLab,
      config,
      deadline: Date.now() + 30_000,
    });
    assert.ok(output && typeof output === "object", `${probe.id} returned ${typeof output}`);
    assert.ok(Array.isArray(output.checks) && output.checks.length > 0, `${probe.id} has no checks`);
    assert.ok(Array.isArray(output.limitations), `${probe.id} has no limitations array`);
    assert.ok(output.observations && typeof output.observations === "object", `${probe.id} has no observations`);
    for (const entry of output.checks) {
      assert.equal(typeof entry.name, "string", `${probe.id} check without name`);
      assert.equal(typeof entry.passed, "boolean", `${probe.id}/${entry.name} passed is not boolean`);
      assert.ok(STATUSES.has(entry.status), `${probe.id}/${entry.name} bad status ${entry.status}`);
      assert.equal(entry.passed, entry.status === "pass", `${probe.id}/${entry.name} passed/status disagree`);
    }
    assert.ok(typeof output.status === "string", `${probe.id} has no status`);
    assert.equal(output.denominator?.total, output.checks.length, `${probe.id} denominator mismatch`);
    process.stdout.write(`PASS contract ${scenario.id}/${probe.id}\n`);
  } catch (error) {
    failures.push(`contract ${probe.id}`);
    process.stdout.write(`FAIL contract ${probe.id} :: ${error.message}\n`);
  }
}

if (failures.length) {
  process.stdout.write(`\nsyntax: ${failures.length} failure(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nsyntax: ${probes.length} probes validated across ${scenarios.length} scenarios\n`);
}
