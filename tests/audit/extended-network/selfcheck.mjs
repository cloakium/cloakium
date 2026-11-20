/**
 * Structural checks for the extended-network launch plans. The lab is a plain
 * object here: these assertions are about plan resolution, not fixtures.
 */
import assert from "node:assert/strict";
import {
  configForScenario, probes, scenarioIds, scenarioLaunch, startLab,
} from "./index.mjs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false });
    process.stdout.write(`FAIL ${name} :: ${error.message}\n`);
  }
}

const lab = {
  origin: "http://127.0.0.1:40001",
  crossOrigin: "http://[::1]:40001",
  port: 40001,
  proxy: {
    http: { url: "http://127.0.0.1:40002", port: 40002 },
    httpAuth: { url: "http://127.0.0.1:40003", port: 40003, credentials: { username: "u", password: "p" } },
    socks5: { url: "socks5://127.0.0.1:40004", port: 40004, stats: () => ({ relayPorts: [] }) },
    socks5Auth: { url: "socks5://127.0.0.1:40005", port: 40005, credentials: { username: "u2", password: "p2" } }
  },
  stun: { url: "stun:127.0.0.1:40006" },
  tap: { url: "https://localhost:40007", port: 40007 },
  transparentProxy: { available: true, url: "http://127.0.0.1:40008", port: 40008 },
  doh: { available: true, url: "https://127.0.0.1:40009/dns-query", template: "https://127.0.0.1:40009/dns-query{?dns}", spkiSha256: "abc" }
};

check("the family re-exports the network probe set", () => {
  assert.equal(probes.length, 31);
  assert.equal(typeof startLab, "function");
});

check("seven extended scenario ids resolve", () => {
  assert.equal(scenarioIds.length, 7);
  for (const id of scenarioIds) {
    const plan = scenarioLaunch(id, lab);
    assert.ok(plan, `${id} did not resolve`);
    assert.equal(plan.id, id);
    assert.equal(plan.skipReason, null, `${id} unexpectedly skipped`);
    assert.ok(plan.probes.length > 0);
  }
  assert.equal(scenarioLaunch("nope", lab), null);
});

check("launcher arguments are caller-supplied, never baked in", () => {
  const base = scenarioLaunch("doh-standard", lab);
  assert.ok(base.launch.args.some((argument) => argument.startsWith("--dns-over-https-templates=")));
  const routed = scenarioLaunch("doh-launcher-route", lab, {
    launcherArgs: { "doh-launcher-route": ["--fingerprint-transparent-proxy-dns=https://127.0.0.1:40009/dns-query"] }
  });
  assert.ok(routed.launch.args.some((argument) => argument.startsWith("--fingerprint-transparent-proxy-dns=")));
  const plain = scenarioLaunch("doh-launcher-route", lab);
  assert.equal(
    plain.launch.args.filter((argument) => argument.startsWith("--fingerprint-transparent-proxy-dns=")).length,
    0,
    "no build-specific switch may be added without the caller asking for it"
  );
});

check("an unavailable DoH fixture marks its dependent scenarios", () => {
  const withoutDoh = { ...lab, doh: { available: false, reason: "not started" } };
  assert.match(scenarioLaunch("doh-launcher-route", withoutDoh).skipReason, /DoH fixture unavailable/);
  assert.match(scenarioLaunch("transparent-doh", withoutDoh).skipReason, /DoH fixture unavailable/);
  assert.equal(scenarioLaunch("transparent-baseline", withoutDoh).skipReason, null);
});

check("transparent-doh extends the probe list with DoH resolution", () => {
  const plan = scenarioLaunch("transparent-doh", lab);
  assert.ok(plan.probes.includes("net.doh.resolution"));
  assert.ok(plan.launch.args.some((argument) => argument.startsWith("--ignore-certificate-errors-spki-list=")));
});

check("rtc-positive selects the STUN positive control and an explicit ICE address", () => {
  const plan = scenarioLaunch("rtc-positive", lab);
  assert.deepEqual(plan.probes, ["net.webrtc.stun-positive-control"]);
  assert.ok(plan.launch.args.includes("--fingerprint-webrtc-ip=203.0.113.9"));
});

check("configForScenario keeps the network contract", () => {
  const plan = scenarioLaunch("transparent-baseline", lab);
  const config = configForScenario(plan);
  assert.equal(config.proxy.mode, "process");
  assert.equal(config.proxy.endpoint, "lab.transparentProxy");
  assert.deepEqual(config.ignoreDefaultArgs, []);
});

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\nextended-network selfcheck: ${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exitCode = 1;
