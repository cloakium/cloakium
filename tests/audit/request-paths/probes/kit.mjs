/** Local helpers for request-path probes. Original code; no third-party imports. */

import { classifyLegacy, correlateAttribution } from './attribution.mjs';

export const STATUS = {
  pass: "pass",
  fail: "fail",
  unavailable: "unavailable",
  stageNeeded: "stage-needed",
  unsupported: "unsupported-by-target",
  inconclusive: "inconclusive",
};

export function pass(name, detail) {
  return { name, passed: true, status: STATUS.pass, ...(detail ? { detail } : {}) };
}

export function fail(name, detail) {
  return { name, passed: false, status: STATUS.fail, ...(detail ? { detail } : {}) };
}

export function stageNeeded(name, detail) {
  return { name, passed: false, status: STATUS.stageNeeded, ...(detail ? { detail } : {}) };
}

export function unsupported(name, detail) {
  return { name, passed: false, status: STATUS.unsupported, ...(detail ? { detail } : {}) };
}

export function inconclusive(name, detail) {
  return { name, passed: null, status: STATUS.inconclusive, ...(detail ? { detail } : {}) };
}

export function result({ observations = {}, checks = [], limitations = [] }) {
  return { observations, checks, limitations, status: summarize(checks), denominator: denominator(checks) };
}

function denominator(checks) {
  const counts = { pass: 0, fail: 0, unavailable: 0, stageNeeded: 0, unsupported: 0, inconclusive: 0 };
  for (const check of checks) {
    if (check.status === STATUS.pass) counts.pass += 1;
    else if (check.status === STATUS.fail) counts.fail += 1;
    else if (check.status === STATUS.stageNeeded) counts.stageNeeded += 1;
    else if (check.status === STATUS.unsupported) counts.unsupported += 1;
    else if (check.status === STATUS.inconclusive) counts.inconclusive += 1;
    else counts.unavailable += 1;
  }
  return { ...counts, total: checks.length };
}

export function summarize(checks) {
  const counts = denominator(checks);
  if (counts.fail > 0) return STATUS.fail;
  if (counts.stageNeeded > 0) return STATUS.stageNeeded;
  if (counts.unsupported > 0) return STATUS.unsupported;
  if (counts.inconclusive > 0) return STATUS.inconclusive;
  if (counts.unavailable > 0) return counts.pass > 0 ? "partial" : STATUS.unavailable;
  return STATUS.pass;
}

/** Remaining wall-clock budget, never above the per-step cap. */
export function remaining(deadline, capMs) {
  if (!Number.isFinite(deadline)) return capMs;
  return Math.max(750, Math.min(capMs, deadline - Date.now()));
}

export function deltaCounters(before, after) {
  const delta = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] === "number" && typeof before[key] === "number") delta[key] = after[key] - before[key];
  }
  return delta;
}

/** Monotonic counters only: gauge fields (open sockets/connections) are not egress evidence. */
export function monotonicDelta(before, after) {
  const delta = deltaCounters(before, after);
  for (const key of Object.keys(delta)) {
    if (/^open[A-Z]/.test(key)) delete delta[key];
  }
  return delta;
}

export function messageOf(error) {
  return String(error?.message ?? error).split("\n")[0];
}

/** Resolve `lab.proxy.httpAuth` style endpoints without mutating the lab. */
export function handleFor(lab, endpoint) {
  if (!lab || !endpoint) return null;
  const trail = endpoint.startsWith("lab.") ? endpoint.slice(4) : endpoint;
  return trail.split(".").reduce((node, key) => (node == null ? undefined : node[key]), lab) ?? null;
}

/** Documented Playwright `proxy` option, credentials only when the fixture needs them. */
export function playwrightProxyOption(lab, endpoint) {
  const handle = handleFor(lab, endpoint);
  if (!handle?.url) return null;
  const proxy = { server: handle.url, bypass: "<-loopback>" };
  if (handle.requireAuth && handle.credentials) {
    proxy.username = handle.credentials.username;
    proxy.password = handle.credentials.password;
  }
  return { proxy };
}

/**
 * Run `work` against the context the scenario selected.
 * process  -> the runner's browser already owns the proxy route; reuse its context.
 * context  -> create an isolated context with the documented Playwright proxy option.
 */
export async function withRoute({ context, browser, config, lab }, work) {
  const mode = config?.proxy?.mode ?? "process";
  if (mode === "process") return { mode: "process", value: await work(context), skipped: null, owned: null };
  const option = playwrightProxyOption(lab, config?.proxy?.endpoint);
  if (!option) return { mode: "context", value: null, skipped: "no lab endpoint for the context proxy", owned: null };
  if (!browser) return { mode: "context", value: null, skipped: "no Browser handle for an isolated context", owned: null };
  const created = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true, ...option });
  try {
    return { mode: "context", value: await work(created), skipped: null, owned: created };
  } finally {
    await created.close().catch(() => {});
  }
}

/**
 * Attribute one request path.
 *
 * With a witness (the proxy's accepted-connection records) the decision is made
 * from the origin receipt's peer port matched against an accepted connection to
 * that exact destination. Counter windows remain available for callers without a
 * witness, but they are explicitly reported with a legacy scope because an
 * unrelated rejected/other-destination connection must never prove egress.
 */
export function classifyEgress({ delta, proxyUrl, receipt, witness = null }) {
  if (witness) {
    const correlated = correlateAttribution({ body: receipt?.body ?? null, witness });
    return {
      ...correlated,
      signal: correlated.method,
      proxyUrl,
    };
  }
  const legacy = classifyLegacy({ delta, proxyUrl, receipt });
  return {
    ...legacy,
    scope: "legacy-counter-window",
    method: "legacy-counters",
    reason: "witness-missing",
    correlation: null,
    proxyUrl,
  };
}

/** Host/path/main-request and proxy-credential hygiene, from the origin receipt. */
export function receiptChecks(receipt, origin) {
  const expectedHost = new URL(origin).host;
  const body = receipt?.body ?? null;
  const names = Array.isArray(body?.headerNames) ? body.headerNames : [];
  const headers = body?.headers ?? {};
  const checks = [
    body
      ? pass("origin-request-observed", `status=${receipt.status}`)
      : fail("origin-request-observed", "the path produced no parseable origin receipt"),
    headers.host === expectedHost
      ? pass("origin-received-original-host", `host=${headers.host}`)
      : fail("origin-received-original-host", `expected ${expectedHost}, got ${headers.host ?? "none"}`),
    body?.path === "/echo"
      ? pass("main-request-path-preserved", "path=/echo")
      : fail("main-request-path-preserved", `path=${body?.path ?? "none"}`),
    names.some((name) => /proxy-authorization/i.test(name))
      ? fail("proxy-credentials-not-at-origin", "origin saw a proxy-authorization header (value redacted by the fixture)")
      : pass("proxy-credentials-not-at-origin", "no proxy-authorization header reached the origin"),
  ];
  return checks;
}

/** Capability outcome for a route that the target may refuse to parse. */
export function routeChecks({ error, delta, receipt, label }) {
  const checks = [];
  const rejected = /ERR_NO_SUPPORTED_PROXIES|ERR_INVALID_ARGUMENT|ERR_PROXY_CONNECTION_FAILED/.test(error ?? "");
  if (error && rejected) {
    checks.push(unsupported(`${label}-route-accepted`, `the process proxy route was refused before traffic: ${error}`));
  } else if (error) {
    checks.push(stageNeeded(`${label}-route-accepted`, `the request path failed before an origin receipt: ${error}`));
  } else if (receipt) {
    checks.push(pass(`${label}-route-accepted`, "the request path reached the fixture origin"));
  } else {
    checks.push(stageNeeded(`${label}-route-accepted`, "the path returned no origin receipt"));
  }
  if ((delta.connects ?? 0) > 0 || (delta.authFail ?? 0) > 0 || (delta.rejectedAuth ?? 0) > 0) {
    checks.push(
      pass(
        "proxy-protocol-activity",
        `connects=${delta.connects ?? 0} authOk=${delta.authOk ?? 0} authFail=${delta.authFail ?? 0} rejectedAuth=${delta.rejectedAuth ?? 0}`,
      ),
    );
  }
  return checks;
}
