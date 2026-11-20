import {
  classifyEgress,
  monotonicDelta,
  fail,
  handleFor,
  messageOf,
  pass,
  receiptChecks,
  remaining,
  result,
  routeChecks,
  stageNeeded,
  inconclusive,
  unsupported,
  withRoute,
} from "./kit.mjs";

const TIMEOUT_MS = 45_000;
const STEP_CAP_MS = 10_000;

function snapshot(lab, endpoint) {
  return handleFor(lab, endpoint)?.stats() ?? {};
}

async function withPage(context, work) {
  const page = await context.newPage();
  try {
    return await work(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function readJson(response) {
  if (!response) return null;
  let status = null;
  try {
    status = response.status();
  } catch {
    status = null;
  }
  try {
    return { status, body: await response.json() };
  } catch {
    return { status, body: null };
  }
}

function pageFetch(page, target, budgetMs) {
  return page.evaluate(
    async ({ url, budget }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
        const body = await response.json().catch(() => null);
        return { status: response.status, body };
      } catch (error) {
        return { status: null, body: null, error: `${error?.name ?? "error"}: ${error?.message ?? "fetch failed"}` };
      } finally {
        clearTimeout(timer);
      }
    },
    { url: target, budget: budgetMs },
  );
}

const ACTIONS = {
  async goto(ctx, measured) {
    return withPage(ctx.scoped, async (page) => {
      await page.route(/\/favicon\.ico$/, (route) => route.abort());
      const navigation = await measured(() =>
        page.goto(`${ctx.origin}/echo?probe=goto`, {
          waitUntil: "domcontentloaded",
          timeout: remaining(ctx.deadline, STEP_CAP_MS),
        }),
      );
      return { receipt: await readJson(navigation), error: null };
    });
  },

  async "page-fetch"(ctx, measured) {
    return withPage(ctx.scoped, async (page) => {
      await page.route(/\/favicon\.ico$/, (route) => route.abort());
      await page.goto(`${ctx.origin}/`, {
        waitUntil: "domcontentloaded",
        timeout: remaining(ctx.deadline, STEP_CAP_MS),
      });
      // Let incidental document requests (e.g. favicon) settle outside the measured window.
      await page
        .waitForLoadState("networkidle", { timeout: remaining(ctx.deadline, 3_000) })
        .catch(() => {});
      const fetched = await measured(() =>
        pageFetch(page, `${ctx.origin}/echo?probe=page-fetch`, remaining(ctx.deadline, STEP_CAP_MS)),
      );
      if (!fetched?.body) return { receipt: null, error: fetched?.error ?? "in-page fetch produced no receipt" };
      return { receipt: { status: fetched.status, body: fetched.body }, error: null };
    });
  },

  async "context-request"(ctx, measured) {
    const response = await measured(() =>
      ctx.scoped.request.get(`${ctx.origin}/echo?probe=context-request`, {
        timeout: remaining(ctx.deadline, STEP_CAP_MS),
      }),
    );
    return { receipt: await readJson(response), error: null };
  },

  async "page-request"(ctx, measured) {
    return withPage(ctx.scoped, async (page) => {
      const response = await measured(() =>
        page.request.get(`${ctx.origin}/echo?probe=page-request`, {
          timeout: remaining(ctx.deadline, STEP_CAP_MS),
        }),
      );
      return { receipt: await readJson(response), error: null };
    });
  },

  async "route-fetch"(ctx, measured) {
    return withPage(ctx.scoped, async (page) => {
      const pattern = /\/echo\?probe=route-fetch$/;
      await page.route(/\/favicon\.ico$/, (route) => route.abort());
      let receipt = null;
      let failure = null;
      let routeHit = false;
      await page.route(pattern, async (route) => {
        routeHit = true;
        try {
          // Measure only route.fetch: the document request is intercepted and never egresses.
          const response = await measured(() => route.fetch({ timeout: remaining(ctx.deadline, STEP_CAP_MS) }));
          const body = await response.json().catch(() => null);
          receipt = { status: response.status(), body };
          await route.fulfill({ response });
        } catch (error) {
          failure = messageOf(error);
          await route.abort("failed").catch(() => {});
        }
      });
      try {
        try {
          await page.goto(`${ctx.origin}/echo?probe=route-fetch`, {
            waitUntil: "domcontentloaded",
            timeout: remaining(ctx.deadline, STEP_CAP_MS),
          });
        } catch (error) {
          return { receipt, error: failure ?? messageOf(error), routeHit };
        }
        return { receipt, error: failure, routeHit };
      } finally {
        await page.unroute(pattern).catch(() => {});
      }
    });
  },
};

async function measurePath(kind, ctx) {
  let delta = {};
  const measured = async (work) => {
    const before = snapshot(ctx.lab, ctx.endpoint);
    try {
      return await work();
    } finally {
      delta = monotonicDelta(before, snapshot(ctx.lab, ctx.endpoint));
    }
  };
  try {
    const outcome = await ACTIONS[kind](ctx, measured);
    return { ...outcome, delta };
  } catch (error) {
    return { receipt: null, error: messageOf(error), delta };
  }
}

function observation({ kind, stack, ctx, outcome, egress }) {
  const handle = handleFor(ctx.lab, ctx.endpoint);
  const body = outcome.receipt?.body ?? null;
  return {
    path: kind,
    stack,
    proxyRouteMode: ctx.config?.proxy?.mode ?? "process",
    proxyEndpoint: ctx.endpoint,
    proxyDelta: outcome.delta,
    taxonomy: {
      egress: egress.mode,
      signal: egress.signal,
      count: egress.count,
      proxied: egress.mode === "proxied" ? true : egress.mode === "direct" ? false : null,
    },
    attribution: {
      scope: egress.scope ?? null,
      method: egress.method ?? null,
      reason: egress.reason ?? null,
      correlation: egress.correlation ?? null,
    },
    receipt: body
      ? {
          status: outcome.receipt.status,
          host: body.headers?.host ?? null,
          path: body.path ?? null,
          search: body.search ?? null,
          peerPort: body.peerPort ?? null,
          receivedAt: body.receivedAt ?? null,
          method: body.method ?? null,
          httpVersion: body.httpVersion ?? null,
        }
      : null,
    error: outcome.error ?? null,
    ...(kind === "route-fetch" ? { routeHit: outcome.routeHit ?? null } : {}),
    credentials: {
      required: Boolean(handle?.requireAuth),
      supplied: Boolean(handle?.requireAuth && handle?.credentials),
      source: "dummy fixture, generated per lab run",
      values: "not recorded",
    },
  };
}

function authChecks(delta, handle) {
  if (!handle?.requireAuth) return [];
  if ((delta.authOk ?? 0) > 0) return [pass("proxy-auth-accepted", `authOk=${delta.authOk}`)];
  if ((delta.rejectedAuth ?? 0) > 0 || (delta.authFail ?? 0) > 0) {
    return [
      unsupported(
        "proxy-auth-accepted",
        `authOk=0 rejectedAuth=${delta.rejectedAuth ?? 0} authFail=${delta.authFail ?? 0}; the route was refused or challenged without success`,
      ),
    ];
  }
  return [inconclusive("proxy-auth-accepted", "no proxy authentication exchange was observed")];
}

const LIMITS_COMMON = [
  "Loopback peers share 127.0.0.1, so proxy-counter deltas attribute egress; peer addresses cannot.",
  "A direct Node-side request still reaches the fixture origin, so origin receipts alone never prove proxy use.",
];

const LIMITS_NODE = [
  "Documented Playwright behaviour: APIRequestContext (context.request, page.request, route.fetch) is implemented with Node http/https and takes only the Playwright `proxy` option, so raw --proxy-server flags are invisible to it.",
  "This is recorded as an observation of the reference SDK, not a template: it is not a Cloakium feature and must not be copied.",
  "Cloakium's own request client must remain proxied through the configured route; this suite verifies the reference paths only.",
];

function probeDefinition({ id, kind, family, stack }) {
  return {
    id,
    family,
    timeoutMs: TIMEOUT_MS,
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.http", "lab.proxy.httpAuth", "lab.proxy.socks5", "lab.proxy.socks5Auth"],
      contextOptions: { proxy: { fromScenario: true } },
      profileLifecycle: "none",
      relaunch: true,
      needs: "a scenario that establishes the proxy route at process level or through the documented Playwright proxy option",
    },
    async run({ context, browser, origin, lab, config, deadline }) {
      if (!lab) {
        return result({
          checks: [stageNeeded("lab-available", "no lab handle was supplied")],
          limitations: ["The fixture lab was not started."],
        });
      }
      const endpoint = config?.proxy?.endpoint ?? null;
      if (!endpoint) {
        return result({
          checks: [stageNeeded("proxy-endpoint-selected", "config.proxy.endpoint is absent")],
          limitations: ["No proxy endpoint was selected for this scenario."],
        });
      }

      const routed = await withRoute({ context, browser, config, lab }, (scoped) =>
        measurePath(kind, { scoped, origin, lab, config, deadline, endpoint }),
      );

      if (routed.skipped) {
        return result({
          observations: { path: kind, stack, routeMode: routed.mode, skipped: routed.skipped },
          checks: [stageNeeded("proxy-route-available", routed.skipped)],
          limitations: ["No proxy route was available, so the path was not exercised."],
        });
      }

      const outcome = routed.value;
      const handle = handleFor(lab, endpoint);
      const witness = snapshot(lab, endpoint);
      const egress = classifyEgress({
        delta: outcome.delta,
        proxyUrl: handle?.url ?? null,
        receipt: outcome.receipt,
        witness,
      });
      const observations = observation({ kind, stack, ctx: { lab, endpoint, config }, outcome, egress });
      const checks = [];

      if (!outcome.receipt) {
        checks.push(...routeChecks({ error: outcome.error, delta: outcome.delta, receipt: outcome.receipt, label: kind }));
        checks.push(...authChecks(outcome.delta, handle));
        return result({
          observations,
          checks,
          limitations: [...LIMITS_COMMON, ...(stack === "node-http" ? LIMITS_NODE : [])],
        });
      }

      checks.push(...receiptChecks(outcome.receipt, origin));
      checks.push(
        egress.mode === "unknown"
          ? inconclusive("egress-mode-determined", "the proxy counter and receipt did not yield a classification")
          : pass("egress-mode-determined", `egress=${egress.mode} via ${egress.signal} (${egress.count})`),
      );

      checks.push(
        egress.scope === "request-connection" && egress.mode !== "unknown"
          ? pass("egress-attribution-correlated", `method=${egress.method} matched=${Boolean(egress.correlation?.matched)} candidates=${egress.correlation?.candidates ?? 0}`)
          : inconclusive("egress-attribution-correlated", egress.reason ?? "no request-level correlation witness"),
      );
      if (kind === "route-fetch") {
        checks.push(outcome.routeHit
          ? pass("route-fetch-handler-hit", "the route handler produced the receipt")
          : fail("route-fetch-handler-hit", "a receipt exists but the route handler never ran"));
      }

      if (stack === "browser") {
        checks.push(
          egress.mode === "proxied"
            ? pass("browser-stack-uses-proxy", `count=${egress.count} through ${endpoint}`)
            : fail(
                "browser-stack-uses-proxy",
                `the browser-stack path reached the origin without advancing the proxy counter (${egress.signal})`,
              ),
        );
      } else {
        checks.push(
          inconclusive(
            "node-side-egress-observation",
            `reference SDK node-side egress is ${egress.mode}; recorded as an observation, never graded as a Cloakium safety result`,
          ),
        );
      }

      checks.push(...authChecks(outcome.delta, handle));

      return result({
        observations,
        checks,
        limitations: [...LIMITS_COMMON, ...(stack === "node-http" ? LIMITS_NODE : [])],
      });
    },
  };
}

export const probes = [
  probeDefinition({
    id: "reqpath.goto.browser-stack",
    kind: "goto",
    family: "request-path-browser-stack",
    stack: "browser",
  }),
  probeDefinition({
    id: "reqpath.page-fetch.browser-stack",
    kind: "page-fetch",
    family: "request-path-browser-stack",
    stack: "browser",
  }),
  probeDefinition({
    id: "reqpath.context-request.api-context",
    kind: "context-request",
    family: "request-path-api-context",
    stack: "node-http",
  }),
  probeDefinition({
    id: "reqpath.page-request.api-context",
    kind: "page-request",
    family: "request-path-api-context",
    stack: "node-http",
  }),
  probeDefinition({
    id: "reqpath.route-fetch.api-context",
    kind: "route-fetch",
    family: "request-path-api-context",
    stack: "node-http",
  }),
];
