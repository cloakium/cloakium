/** Structural contract validation: no browser, no network, no behaviour claims. */
import assert from "node:assert/strict";
import { probes, probeIds } from "../probes/index.mjs";
import { scenarios, scenarioLaunch, configForScenario } from "../scenarios.mjs";
import { receiptChecks, routeChecks, classifyEgress, deltaCounters } from "../probes/kit.mjs";

const findings = [];
const record = (name) => findings.push(name);

assert(Array.isArray(probes) && probes.length === 5, "expected five probes");
assert.equal(new Set(probeIds).size, probeIds.length, "probe ids must be unique");
for (const probe of probes) {
  assert.match(probe.id, /^reqpath\.[a-z0-9-]+\.[a-z0-9-]+$/, `${probe.id}: bad id`);
  assert.equal(typeof probe.family, "string");
  assert(Number.isInteger(probe.timeoutMs) && probe.timeoutMs > 0 && probe.timeoutMs <= 45_000, `${probe.id}: timeout`);
  assert.equal(typeof probe.run, "function");
  assert.equal(typeof probe.requirements, "object");
}
record("probes: ids, families, 45s timeout ceiling, run() present");

const fakeLab = {
  proxy: {
    http: { url: "http://127.0.0.1:41001", port: 41001, requireAuth: false, stats: () => ({ absoluteRequests: 0 }), credentials: null },
    httpAuth: {
      url: "http://127.0.0.1:41002",
      port: 41002,
      requireAuth: true,
      credentials: { username: "http-dummy-user", password: "http-dummy-secret-value" },
      stats: () => ({ absoluteRequests: 0 }),
    },
    socks5: { url: "socks5://127.0.0.1:41003", port: 41003, requireAuth: false, stats: () => ({ connects: 0 }), credentials: null },
    socks5Auth: {
      url: "socks5://127.0.0.1:41004",
      port: 41004,
      requireAuth: true,
      credentials: { username: "socks-dummy-user", password: "socks-dummy-secret-value" },
      stats: () => ({ connects: 0 }),
    },
  },
};

assert.equal(scenarios.length, 5, "expected five scenarios");
assert.equal(new Set(scenarios.map((entry) => entry.id)).size, scenarios.length, "scenario ids must be unique");

for (const scenario of scenarios) {
  for (const id of scenario.probes) assert(probeIds.includes(id), `${scenario.id}: unknown probe ${id}`);
  const plan = scenarioLaunch(scenario.id, fakeLab);
  assert(plan, `${scenario.id}: scenarioLaunch returned null`);
  assert.equal(plan.skipReason, null, `${scenario.id}: unexpected skipReason`);
  assert(["process", "context"].includes(plan.proxyMode), `${scenario.id}: bad proxyMode`);
  assert(typeof plan.proxyRoute === "string");
  assert.equal(typeof plan.launch.args, "object");
  assert(Array.isArray(plan.launch.ignoreDefaultArgs));
  assert.equal(plan.profileLifecycle, "fresh-context");

  for (const argument of plan.launch.args) {
    assert.match(argument, /^--/, `${scenario.id}: non-flag argument ${argument}`);
    assert(!/--no-sandbox|disable-setuid-sandbox|disable-web-security|ignore-certificate-errors(?!-spki-list)/.test(argument),
      `${scenario.id}: unsafe argument ${argument}`);
  }

  const config = configForScenario(plan);
  assert.equal(config.proxy.mode, plan.proxyMode);
  assert.equal(config.proxy.endpoint, plan.proxyEndpoint);
  assert.equal(config.proxy.route, plan.proxyRoute);
  const serialized = JSON.stringify(config);
  assert(!serialized.includes("dummy-secret-value"), `${scenario.id}: config leaked a credential value`);
  assert(!serialized.includes("dummy-user"), `${scenario.id}: config leaked a credential name`);
  if (plan.proxyMode === "context") {
    assert(plan.contextOptions.proxy?.server, `${scenario.id}: context proxy not resolved`);
  } else {
    assert.equal(plan.contextOptions.proxy, undefined, `${scenario.id}: unexpected context proxy`);
  }
}
record("scenarios: five unique ids, valid probes, safe flags, credential-free config");

assert.equal(scenarios.filter((entry) => entry.proxyRoute === "playwright-option").length, 1);
assert.equal(scenarios.filter((entry) => entry.proxyRoute === "raw-flags-inline").length, 2);
assert.equal(scenarios.filter((entry) => entry.proxyRoute === "raw-flags").length, 2);
record("route taxonomy: raw-flags x2, raw-flags-inline x2, playwright-option x1");

const shapeChecks = [
  ...receiptChecks(null, "http://127.0.0.1:1"),
  ...routeChecks({ error: "ERR_NO_SUPPORTED_PROXIES", delta: {}, receipt: null, label: "x" }),
  ...routeChecks({ error: null, delta: { connects: 1 }, receipt: { body: {} }, label: "y" }),
];
for (const check of shapeChecks) {
  assert.equal(typeof check.name, "string");
  assert(check.passed === true || check.passed === false || check.passed === null, `${check.name}: passed must be boolean|null`);
}
record("check builders always yield name + boolean|null passed");

assert.equal(classifyEgress({ delta: { absoluteRequests: 1 }, proxyUrl: "http://x", receipt: { body: {} } }).mode, "proxied");
assert.equal(classifyEgress({ delta: { connects: 1 }, proxyUrl: "http://x", receipt: { body: {} } }).mode, "proxied");
assert.equal(classifyEgress({ delta: { absoluteRequests: 0, connects: 0 }, proxyUrl: "http://x", receipt: { body: {} } }).mode, "direct");
assert.equal(classifyEgress({ delta: { connects: 1 }, proxyUrl: "socks5://x", receipt: { body: {} } }).mode, "proxied");
assert.equal(classifyEgress({ delta: {}, proxyUrl: "http://x", receipt: null }).mode, "unknown");
assert.deepEqual(deltaCounters({ a: 1 }, { a: 3 }), { a: 2 });
record("classification and counter deltas are pure and deterministic");

assert.equal(scenarioLaunch("does-not-exist", fakeLab), null);
record("unknown scenario id returns null");

console.log(JSON.stringify({ ok: findings.length, checks: [], findings }, null, 2));
