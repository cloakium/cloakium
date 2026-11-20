/** Five launch plans: raw proxy flags vs the documented Playwright proxy option. */

const TEMPLATE = /\{lab\.([a-zA-Z0-9_.]+)\}/g;

function endpointHandle(lab, endpoint) {
  const trail = endpoint.startsWith("lab.") ? endpoint.slice(4) : endpoint;
  return trail.split(".").reduce((node, key) => (node == null ? undefined : node[key]), lab) ?? null;
}

function resolveTemplate(text, lab) {
  return String(text)
    .replace(/\{inline:(lab\.[a-zA-Z0-9_.]+)\}/g, (_match, path) => {
      const handle = endpointHandle(lab, path);
      if (!handle?.url || !handle?.credentials) return "";
      const user = encodeURIComponent(handle.credentials.username);
      const pass = encodeURIComponent(handle.credentials.password);
      return handle.url.replace("://", `://${user}:${pass}@`);
    })
    .replace(TEMPLATE, (_match, path) => {
      const value = endpointHandle(lab, `lab.${path}`);
      return value == null ? "" : String(value);
    });
}

const ALL_PROBES = [
  "reqpath.goto.browser-stack",
  "reqpath.page-fetch.browser-stack",
  "reqpath.context-request.api-context",
  "reqpath.page-request.api-context",
  "reqpath.route-fetch.api-context",
];

export const scenarios = [
  {
    id: "rp-raw-http-anon",
    description: "Process-level raw --proxy-server (anonymous HTTP) with <-loopback>; the browser-stack control.",
    launch: {
      args: ["--proxy-server={lab.proxy.http.url}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.http",
    proxyMode: "process",
    proxyRoute: "raw-flags",
    profileLifecycle: "fresh-context",
    probes: ALL_PROBES,
  },
  {
    id: "rp-pw-http-auth",
    description: "Documented Playwright launch `proxy` option (HTTP Basic, dummy fixture credentials), same process-wide scope as raw flags.",
    launch: {
      args: [],
      ignoreDefaultArgs: [],
      proxyFrom: "lab.proxy.httpAuth",
      credentials: true,
      bypass: "<-loopback>",
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.httpAuth",
    proxyMode: "process",
    proxyRoute: "playwright-option",
    profileLifecycle: "fresh-context",
    probes: ALL_PROBES,
  },
  {
    id: "rp-raw-http-inline",
    description: "Process-level raw --proxy-server carrying INLINE dummy Basic credentials; capability check for launcher-level auth.",
    launch: {
      args: ["--proxy-server={inline:lab.proxy.httpAuth}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.httpAuth",
    proxyMode: "process",
    proxyRoute: "raw-flags-inline",
    profileLifecycle: "fresh-context",
    probes: ALL_PROBES,
  },
  {
    id: "rp-raw-socks5",
    description: "Process-level raw SOCKS5 (RFC 1928, no auth); browser-stack control over a SOCKS route.",
    launch: {
      args: ["--proxy-server={lab.proxy.socks5.url}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.socks5",
    proxyMode: "process",
    proxyRoute: "raw-flags",
    profileLifecycle: "fresh-context",
    probes: ALL_PROBES,
  },
  {
    id: "rp-raw-socks5-inline-auth",
    description: "Process-level raw SOCKS5 with INLINE dummy RFC 1929 credentials; capability check for native inline SOCKS auth.",
    launch: {
      args: ["--proxy-server={inline:lab.proxy.socks5Auth}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.socks5Auth",
    proxyMode: "process",
    proxyRoute: "raw-flags-inline",
    profileLifecycle: "fresh-context",
    probes: ALL_PROBES,
  },
];

export function scenarioForProbe(probeId) {
  return scenarios.find((scenario) => scenario.probes.includes(probeId)) ?? null;
}

/**
 * Resolve a scenario against a live lab. `launch.proxy` is ready for Playwright's
 * documented launch option; `launch.args` is ready for a raw command line.
 */
export function scenarioLaunch(scenarioId, lab) {
  const scenario = scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) return null;
  const plan = scenario.launch ?? {};
  const handle = endpointHandle(lab, scenario.proxyEndpoint);
  const skipReason = handle?.url ? null : `${scenario.proxyEndpoint} unavailable`;

  const args = (plan.args ?? []).map((argument) => resolveTemplate(argument, lab));
  let proxy = null;
  if (plan.proxyFrom) {
    const source = endpointHandle(lab, plan.proxyFrom);
    if (source?.url) {
      proxy = { server: source.url, bypass: plan.bypass ?? "<-loopback>" };
      if (plan.credentials && source.credentials) {
        proxy.username = source.credentials.username;
        proxy.password = source.credentials.password;
      }
    }
  }

  const contextOptions = { ...scenario.contextOptions };
  if (scenario.proxyMode === "context") {
    const source = endpointHandle(lab, scenario.proxyEndpoint);
    if (source?.url) {
      contextOptions.proxy = { server: source.url, bypass: "<-loopback>" };
      if (source.requireAuth && source.credentials) {
        contextOptions.proxy.username = source.credentials.username;
        contextOptions.proxy.password = source.credentials.password;
      }
    }
  }

  return {
    id: scenario.id,
    description: scenario.description,
    skipReason,
    launch: { args, ignoreDefaultArgs: [...(plan.ignoreDefaultArgs ?? [])], proxy },
    contextOptions,
    webrtcPolicy: scenario.webrtcPolicy ?? null,
    proxyEndpoint: scenario.proxyEndpoint,
    proxyMode: scenario.proxyMode,
    proxyRoute: scenario.proxyRoute,
    profileLifecycle: scenario.profileLifecycle,
    probes: [...scenario.probes],
  };
}

/** Keep launch-arg shape while removing inline credential material. */
function redactArgument(argument) {
  return String(argument).replace(/((?:https?|socks5h?):\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
}

/** Probe-facing config. Carries the route shape only: no credential values. */
export function configForScenario(plan, { playwrightDefaults = true, trustLabCa = false } = {}) {
  return {
    scenarioId: plan.id,
    launchArgs: (plan.launch.args ?? []).map(redactArgument),
    ignoreDefaultArgs: [...(plan.launch.ignoreDefaultArgs ?? [])],
    playwrightDefaults,
    trustLabCa,
    webrtcPolicy: plan.webrtcPolicy,
    proxy: { mode: plan.proxyMode, endpoint: plan.proxyEndpoint, route: plan.proxyRoute },
  };
}
