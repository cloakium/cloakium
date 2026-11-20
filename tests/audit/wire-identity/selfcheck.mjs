/**
 * Unit checks for the wire-identity family: the header comparison is pure, so
 * its tri-state behaviour is asserted against synthetic receipts.
 */
import assert from "node:assert/strict";
import {
  IDENTITY_ACCEPT_CH, IDENTITY_ACCEPT_CH_VALUE, acceptCHMatches, fullVersionListMatches,
  highEntropyCount, identityChecks, parseFullVersionList, probes
} from "./index.mjs";
import { startLab } from "../network/index.mjs";

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

const sample = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  language: "en-GB",
  platform: "Linux x86_64",
  uaPlatform: "Linux",
  highEntropy: { platformVersion: "6.5.0", architecture: "x86", bitness: "64" }
};

const matching = {
  "user-agent": sample.userAgent,
  "accept-language": "en-GB,en;q=0.9",
  "sec-ch-ua-platform": '"Linux"',
  "sec-ch-ua-platform-version": '"6.5.0"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"'
};

function named(checks, name) {
  return checks.find((entry) => entry.name === name);
}

check("matching receipt passes every check", () => {
  const checks = identityChecks(sample, matching, "main");
  assert.equal(checks.length, 6);
  for (const entry of checks) assert.equal(entry.passed, true, entry.name);
});

check("a divergent client hint fails instead of passing silently", () => {
  const divergent = { ...matching, "sec-ch-ua-platform": '"Windows"' };
  const checks = identityChecks(sample, divergent, "main");
  assert.equal(named(checks, "main/platform-reaches-server").passed, false);
  assert.equal(named(checks, "main/platformVersion-reaches-server").passed, true);
});

check("a missing client hint is unknown, never a pass", () => {
  const sparse = { "user-agent": sample.userAgent, "accept-language": "en-GB" };
  const checks = identityChecks(sample, sparse, "worker");
  for (const entry of checks.filter((row) => row.name.includes("reaches-server") && row.name !== "worker/user-agent-reaches-server" && row.name !== "worker/primary-language-reaches-server")) {
    assert.equal(entry.passed, null, entry.name);
  }
  assert.equal(named(checks, "worker/user-agent-reaches-server").passed, true);
});

check("an unquoted header value is unknown for high-entropy fields", () => {
  const unquoted = { ...matching, "sec-ch-ua-arch": "x86" };
  const checks = identityChecks(sample, unquoted, "main");
  assert.equal(named(checks, "main/architecture-reaches-server").passed, null);
  assert.deepEqual(named(checks, "main/architecture-reaches-server").detail, { server: null, javascript: "x86" });
});

check("the probe observes a server receipt rather than CDP metadata", () => {
  assert.equal(probes.length, 1);
  const probe = probes[0];
  assert.equal(probe.id, "wire-main-worker-identity");
  assert.ok(Number.isInteger(probe.timeoutMs) && probe.timeoutMs > 0);
  assert.match(probe.family, /identity/);
});

check("no page-state overrides in the probe source", () => {
  const source = probes[0].run.toString();
  assert.ok(!/Object\.defineProperty/.test(source));
  assert.ok(!/navigator\.[A-Za-z]+\s*=(?!=)/.test(source));
});

check("accept-ch policy comparison is token-set based", () => {
  assert.equal(acceptCHMatches(IDENTITY_ACCEPT_CH_VALUE), true);
  assert.equal(acceptCHMatches(IDENTITY_ACCEPT_CH_VALUE.toLowerCase()), true);
  assert.equal(acceptCHMatches(`${IDENTITY_ACCEPT_CH_VALUE}, Sec-CH-UA-Model`), false);
  assert.equal(acceptCHMatches(null), null);
  assert.equal(acceptCHMatches(""), false);
});

check("high-entropy counting uses the standard header names", () => {
  assert.equal(highEntropyCount({}), 0);
  assert.equal(highEntropyCount({ "sec-ch-ua-arch": '"x86"' }), 1);
  assert.equal(highEntropyCount({
    "sec-ch-ua-platform-version": '"6.5.0"', "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"', "sec-ch-ua-full-version-list": '"Chromium";v="1"'
  }), 4);
});

check("full-version-list parser handles quoted brands, escapes and order", () => {
  const parsed = parseFullVersionList('"Not A(Brand";v="99", "Chromium";v="157.0.1"');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.list, [{ brand: "Not A(Brand", version: "99" }, { brand: "Chromium", version: "157.0.1" }]);
  assert.equal(fullVersionListMatches([{ brand: "Chromium", version: "157.0.1" }, { brand: "Not A(Brand", version: "99" }], '"Not A(Brand";v="99", "Chromium";v="157.0.1"').state, "match");
  assert.equal(parseFullVersionList('"Foo, Bar; Baz";v="1"').list[0].brand, "Foo, Bar; Baz");
  assert.equal(parseFullVersionList('"Foo\\"Bar";v="1"').list[0].brand, 'Foo"Bar');
});

check("full-version-list comparison is duplicate-sensitive and never guesses", () => {
  const header = '"A";v="1", "B";v="2"';
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }, { brand: "B", version: "2" }], header).state, "match");
  assert.equal(fullVersionListMatches([{ brand: "B", version: "2" }, { brand: "A", version: "1" }], header).state, "match");
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }, { brand: "B", version: "9" }], header).state, "mismatch");
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }, { brand: "A", version: "1" }], '"A";v="1"').state, "mismatch");
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }], undefined).state, "unavailable");
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }], "A;v=1").state, "parse-error");
  assert.equal(fullVersionListMatches([{ brand: "A", version: "1" }], `"A";v="1", ${"x".repeat(5000)}`).state, "parse-error");
  assert.equal(parseFullVersionList(Array.from({ length: 70 }, (_, i) => `"B${i}";v="1"`).join(", ")).state, "parse-error");
});

check("the probe checks the full-version-list coherence", () => {
  const source = String(probes[0].run);
  assert.ok(source.includes("main/full-version-list-matches"));
  assert.ok(source.includes("worker/full-version-list-matches"));
});

check("the probe navigates the opt-in route instead of the bare origin", () => {
  const source = String(probes[0].run);
  assert.ok(source.includes("/identity"), "probe must complete a navigation to /identity");
  assert.ok(!/page\.goto\(\s*origin\s*\)/.test(source), "probe must not prime with a bare origin navigation");
});

const lab = await startLab({ tls: false, http2: false, h3: false, doh: false, transparentProxy: false });
try {
  const identity = await fetch(`${lab.origin}/identity`);
  assert.equal(identity.headers.get("accept-ch"), IDENTITY_ACCEPT_CH_VALUE);
  assert.equal(identity.headers.get("cache-control"), "no-store");
  assert.match(await identity.text(), /identity-fixture/);

  const headers = await fetch(`${lab.origin}/headers`);
  assert.equal(headers.headers.get("accept-ch"), IDENTITY_ACCEPT_CH_VALUE);
  const receipt = await headers.json();
  assert.deepEqual(receipt.policy, IDENTITY_ACCEPT_CH);
  assert.equal(receipt.acceptCH, IDENTITY_ACCEPT_CH_VALUE);
  assert.equal(receipt.clientHints.length, IDENTITY_ACCEPT_CH.length);
  for (const hint of receipt.clientHints) assert.equal(hint.value, null, "no request hints without opt-in by the client");

  const bare = await fetch(`${lab.origin}/`);
  assert.equal(bare.headers.get("accept-ch"), null, "other routes must not advertise a client-hint policy");
  const echo = await fetch(`${lab.origin}/echo`);
  assert.equal(echo.headers.get("accept-ch"), null);
  results.push({ name: "HTTP policy: /identity and /headers only", ok: true });
  process.stdout.write("PASS HTTP policy: /identity and /headers only\n");
} catch (error) {
  results.push({ name: "HTTP policy: /identity and /headers only", ok: false });
  process.stdout.write(`FAIL HTTP policy: /identity and /headers only :: ${error.message}\n`);
} finally {
  await lab.close();
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\nwire-identity selfcheck: ${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exitCode = 1;
