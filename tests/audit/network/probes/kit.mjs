/** Shared probe helpers: check shaping, context creation, wall-clock guards. */

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

export function unavailable(name, detail) {
  return { name, passed: false, status: STATUS.unavailable, ...(detail ? { detail } : {}) };
}

export function stageNeeded(name, detail) {
  return { name, passed: false, status: STATUS.stageNeeded, ...(detail ? { detail } : {}) };
}

export function unsupported(name, detail) {
  return { name, passed: false, status: STATUS.unsupported, ...(detail ? { detail } : {}) };
}

export function inconclusive(name, detail) {
  return { name, passed: false, status: STATUS.inconclusive, ...(detail ? { detail } : {}) };
}

/** Derive a probe status and an explicit denominator from its checks. */
export function summarize(checks) {
  const counts = { pass: 0, fail: 0, unavailable: 0, stageNeeded: 0, unsupported: 0, inconclusive: 0 };
  for (const check of checks) {
    if (check.status === STATUS.pass) counts.pass += 1;
    else if (check.status === STATUS.fail) counts.fail += 1;
    else if (check.status === STATUS.stageNeeded) counts.stageNeeded += 1;
    else if (check.status === STATUS.unsupported) counts.unsupported += 1;
    else if (check.status === STATUS.inconclusive) counts.inconclusive += 1;
    else counts.unavailable += 1;
  }
  let status = STATUS.pass;
  if (counts.fail > 0) status = STATUS.fail;
  else if (counts.stageNeeded > 0) status = STATUS.stageNeeded;
  else if (counts.unsupported > 0) status = STATUS.unsupported;
  else if (counts.inconclusive > 0) status = STATUS.inconclusive;
  else if (counts.unavailable > 0) status = counts.pass > 0 ? "partial" : STATUS.unavailable;
  return { status, denominator: { ...counts, total: checks.length } };
}

export function result({ observations = {}, checks = [], limitations = [] }) {
  const summary = summarize(checks);
  return { observations, checks, limitations, status: summary.status, denominator: summary.denominator };
}

/** Remaining wall-clock budget, clamped so callers never exceed their deadline. */
export function remaining(deadline, fallbackMs) {
  if (!Number.isFinite(deadline)) return fallbackMs;
  return Math.max(1_000, Math.min(fallbackMs, deadline - Date.now()));
}

/**
 * Create a probe-owned context. Prefers the harness-supplied Browser so a
 * persistent-context launch still yields isolated incognito contexts.
 */
export async function newProbeContext(context, options = {}, { browser = null } = {}) {
  let owner = browser;
  if (!owner) {
    try {
      owner = context.browser();
    } catch {
      owner = null;
    }
  }
  if (!owner) return { context: null, reason: "no Browser handle; cannot create an isolated context" };
  try {
    const created = await owner.newContext(options);
    return { context: created, reason: null };
  } catch (error) {
    return { context: null, reason: `browser.newContext failed: ${error.message.split("\n")[0]}` };
  }
}

export async function withProbeContext(context, options, work, owner = {}) {
  const created = await newProbeContext(context, options, owner);
  if (!created.context) return { skipped: created.reason, value: null };
  try {
    return { skipped: null, value: await work(created.context) };
  } finally {
    await created.context.close().catch(() => {});
  }
}

export function deltaCounters(before, after) {
  const delta = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] === "number" && typeof before[key] === "number") delta[key] = after[key] - before[key];
  }
  return delta;
}

/**
 * Decide how a probe should obtain its proxy route.
 *
 * config.proxy.mode:
 *   "process" - the browser process already has --proxy-server; reuse `context`.
 *   "context" - Playwright per-context proxy (default, no relaunch).
 *   "none"    - no proxy expected; probes that need one report stage-needed.
 */
export function proxyPlan({ config = null, context = null, lab = null, endpoint = null } = {}) {
  const proxy = config?.proxy ?? null;
  if (!proxy || proxy.mode === "context") {
    if (!endpoint || !lab) return { use: null, options: {}, reason: "no lab endpoint" };
    const trail = endpoint.startsWith("lab.") ? endpoint.slice(4) : endpoint;
    const handle = trail.split(".").reduce((value, key) => value?.[key], lab);
    if (!handle?.url) return { use: null, options: {}, reason: `lab endpoint ${endpoint} unavailable` };
    return { use: "new-context", options: { proxy: { server: handle.url, bypass: "<-loopback>" } }, reason: null };
  }
  if (proxy.mode === "process") {
    if (proxy.endpoint && endpoint && proxy.endpoint !== endpoint) {
      return {
        use: null,
        options: {},
        reason: `this browser process is routed to ${proxy.endpoint}; run the scenario that routes to ${endpoint} instead`,
      };
    }
    return { use: "existing-context", options: {}, reason: null, context };
  }
  return { use: null, options: {}, reason: "config.proxy.mode is 'none'; this probe needs a proxy route" };
}

/** Run `work` against whichever context the proxy plan selected. */
export async function withProxyContext({ context, browser, config, lab, endpoint }, work, extraOptions = {}) {
  const plan = proxyPlan({ context, lab, endpoint, config });
  if (!plan.use) return { skipped: plan.reason, value: null, mode: "none" };
  if (plan.use === "existing-context") {
    return { skipped: null, value: await work(context), mode: "process" };
  }
  const merged = {
    ...plan.options,
    ...extraOptions,
    proxy: { ...(plan.options.proxy ?? {}), ...(extraOptions.proxy ?? {}) },
  };
  if (!merged.proxy?.server) delete merged.proxy;
  const nested = await withProbeContext(context, merged, work, { browser });
  return { ...nested, mode: "context" };
}

export async function fetchJson(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  const body = await response?.text();
  try {
    return JSON.parse(body ?? "null");
  } catch {
    return null;
  }
}

export async function navigateExpectingFailure(page, url, timeoutMs = 8_000) {
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: "commit" });
    return { failed: false, error: null };
  } catch (error) {
    return { failed: true, error: String(error.message).split("\n")[0] };
  }
}

/**
 * ICE gathering with a wall-clock bound. Candidate metadata is secondary: the
 * STUN responder counters are the authoritative proof that UDP left the browser.
 */
export async function gatherIce(page, { stunUrl = null, timeoutMs = 6_000 } = {}) {
  return page.evaluate(
    async ({ stunUrl: target, timeoutMs: budget }) => {
      const configuration = target ? { iceServers: [{ urls: target }] } : {};
      const peer = new RTCPeerConnection(configuration);
      const candidates = [];
      peer.createDataChannel("lab-probe");
      const gathering = new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), budget);
        const finish = (state) => {
          clearTimeout(timer);
          resolve(state);
        };
        peer.onicecandidate = (event) => {
          if (!event.candidate) {
            finish("complete");
            return;
          }
          candidates.push({
            text: String(event.candidate.candidate),
            type: event.candidate.type ?? null,
            protocol: event.candidate.protocol ?? null,
          });
        };
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === "complete") finish("complete");
        };
        peer.onicecandidateerror = () => {};
      });
      await peer.setLocalDescription(await peer.createOffer());
      const settled = await gathering;
      const stats = [];
      try {
        const report = await peer.getStats();
        report.forEach((entry) => {
          if (entry.type === "local-candidate") {
            stats.push({ type: entry.candidateType, protocol: entry.protocol, address: entry.address, port: entry.port });
          }
        });
      } catch {
        /* stats are optional */
      }
      peer.close();
      return { settled, candidates, stats, candidateTypes: [...new Set(candidates.map((entry) => entry.type))] };
    },
    { stunUrl, timeoutMs },
  );
}
