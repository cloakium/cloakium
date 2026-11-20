/** Sequential launch plans. One browser process per scenario, probes run in order. */

const TEMPLATE = /\{lab\.([a-zA-Z0-9_.]+)\}/g;

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
      const value = path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), lab);
      return value == null ? "" : String(value);
    });
}

function endpointHandle(lab, endpoint) {
  const trail = endpoint.startsWith("lab.") ? endpoint.slice(4) : endpoint;
  return trail.split(".").reduce((node, key) => (node == null ? undefined : node[key]), lab) ?? null;
}

export const scenarios = [
  {
    id: "default",
    description: "No proxy, browser defaults, popup blocker left as the launcher provides it.",
    launch: { args: [], ignoreDefaultArgs: [] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "fresh-context",
    probes: [
      "net.webrtc.stun-positive-control",
      "net.tls.clienthello-metadata",
      "net.tls.http2-negotiation",
      "net.cache.fresh-and-no-store",
      "net.cache.revalidation",
      "net.timing.navigation-metadata",
      "cookies.chips-partition",
      "cookies.store-coherence",
      "storage.quota-coherence",
      "storage.buckets-and-persistence",
      "dom.closed-shadow-cdp-diagnostic",
      "page.navigation-flood-resilience",
    ],
  },
  {
    id: "cookies-3pc-default",
    description: "Third-party cookies left at the browser's default policy; records the effective mode rather than assuming it.",
    launch: { args: [], ignoreDefaultArgs: [] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "fresh-context",
    probes: ["cookies.third-party-default-behavior"],
  },
  {
    id: "cookies-3pc-restricted",
    description: "Third-party cookies restricted through CDP controls; asserts the restriction actually blocks a third-party write.",
    launch: { args: [], ignoreDefaultArgs: [] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "fresh-context",
    probes: ["cookies.third-party-control-cdp"],
  },
  {
    id: "storage-quota-override",
    description: "Per-origin quota override (small, bounded) to test estimate/override coherence and the enforcement boundary without stressing the real quota.",
    launch: { args: [], ignoreDefaultArgs: [] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "fresh-context",
    probes: ["storage.quota-override"],
  },
  {
    id: "http-proxy",
    description: "Process-level HTTP forward proxy; loopback must not be bypassed.",
    launch: {
      args: ["--proxy-server={lab.proxy.http.url}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.http",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: [
      "net.proxy.http.absolute-form",
      "net.proxy.http.no-external-egress",
      "net.proxy.header-hygiene-e2e",
      "net.dns.remote-resolution",
    ],
  },
  {
    id: "http-proxy-auth",
    description: "Process-level HTTP proxy requiring Basic auth (dummy fixture credentials).",
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
    profileLifecycle: "fresh-context",
    probes: ["net.proxy.http.connect-auth"],
  },
  {
    id: "socks5",
    description: "Process-level SOCKS5 proxy with the documented disable_non_proxied_udp policy; used to test TCP routing, remote DNS form and UDP bypass.",
    launch: {
      args: [
        "--proxy-server={lab.proxy.socks5.url}",
        "--proxy-bypass-list=<-loopback>",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: "disable_non_proxied_udp",
    proxyEndpoint: "lab.proxy.socks5",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.socks5.connect-routing", "net.socks5.udp-associate-no-bypass"],
  },
  {
    id: "socks5-auth",
    description: "SOCKS5 server requiring RFC 1929 reached WITHOUT credentials; enforcement control.",
    launch: {
      args: ["--proxy-server={lab.proxy.socks5Auth.url}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.socks5Auth",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.socks5.auth-negative-control"],
  },
  {
    id: "socks5-auth-inline",
    description: "SOCKS5 server requiring RFC 1929 reached with INLINE dummy credentials in --proxy-server; capabilities test.",
    launch: {
      args: ["--proxy-server={inline:lab.proxy.socks5Auth}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.socks5Auth",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.socks5.userpass-auth"],
  },
  {
    id: "http-proxy-auth-inline",
    description: "HTTP CONNECT proxy requiring Basic auth reached with INLINE dummy credentials in --proxy-server.",
    launch: {
      args: ["--proxy-server={inline:lab.proxy.httpAuth}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null, ignoreHTTPSErrors: true },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.httpAuth",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.proxy.http.connect-auth-inline"],
  },
  {
    id: "h3-direct",
    description: "Direct HTTP/3 positive control: QUIC enabled, ephemeral fixture certificate pinned by SPKI only.",
    launch: {
      args: [
        "--enable-quic",
        "--origin-to-force-quic-on={lab.h3.forceQuicOrigin}",
        "--ignore-certificate-errors-spki-list={lab.h3.spkiSha256}",
      ],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    requiresEndpoint: "lab.h3",
    profileLifecycle: "fresh-context",
    probes: ["net.h3.direct-positive-control"],
  },
  {
    id: "h3-socks5",
    description: "QUIC through the fixture SOCKS5 relay: server peer ports are attributed against relay upstream ports.",
    launch: {
      args: [
        "--enable-quic",
        "--origin-to-force-quic-on={lab.h3.forceQuicOrigin}",
        "--ignore-certificate-errors-spki-list={lab.h3.spkiSha256}",
        "--proxy-server={lab.proxy.socks5.url}",
        "--proxy-bypass-list=<-loopback>",
      ],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    requiresEndpoint: "lab.h3",
    proxyEndpoint: "lab.proxy.socks5",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.h3.quic-over-socks5"],
  },
  {
    id: "doh",
    description: "DNS-over-HTTPS through the loopback RFC 8484 fixture, using the documented Chrome DoH switches (or an equivalent launcher-provided DoH route).",
    launch: {
      args: [
        "--dns-over-https-mode=secure",
        "--dns-over-https-templates={lab.doh.template}",
        "--ignore-certificate-errors-spki-list={lab.doh.spkiSha256}",
      ],
      ignoreDefaultArgs: [],
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    requiresEndpoint: "lab.doh",
    profileLifecycle: "fresh-context",
    probes: ["net.doh.resolution"],
  },
  {
    id: "transparent-proxy",
    description: "Transparent-proxy surface: records whether origin-form or absolute-form arrives, loopback only.",
    launch: {
      args: ["--proxy-server={lab.transparentProxy.url}", "--proxy-bypass-list=<-loopback>"],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    requiresEndpoint: "lab.transparentProxy",
    proxyEndpoint: "lab.transparentProxy",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.proxy.transparent-form"],
  },
  {
    id: "socks5-webrtc-forced",
    description: "Documented shape for UDP-over-SOCKS WebRTC: forced disable_non_proxied_udp policy plus an explicit ICE IP.",
    launch: {
      args: [
        "--proxy-server={lab.proxy.socks5.url}",
        "--proxy-bypass-list=<-loopback>",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--fingerprint-webrtc-ip=203.0.113.9",
      ],
      ignoreDefaultArgs: [],
      proxyFrom: null,
    },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    proxyEndpoint: "lab.proxy.socks5",
    proxyMode: "process",
    profileLifecycle: "fresh-context",
    probes: ["net.socks5.udp-associate-no-bypass"],
  },
  {
    id: "popup-blocker",
    description: "Chromium defaults but with the popup blocker left active (Playwright disables it by default).",
    launch: { args: [], ignoreDefaultArgs: ["--disable-popup-blocking"] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "fresh-context",
    probes: ["page.popup-flood-protection"],
  },
  {
    id: "caller-profile",
    description: "Caller-owned persistent profile, used only to inspect portable-export security behaviour.",
    launch: { args: [], ignoreDefaultArgs: [] },
    contextOptions: { viewport: null },
    webrtcPolicy: null,
    profileLifecycle: "caller-profile",
    probes: ["profile.export.security"],
  },
];

export function scenarioForProbe(probeId) {
  return scenarios.find((scenario) => scenario.probes.includes(probeId)) ?? null;
}

/**
 * Resolve a scenario to concrete launch options for the current lab.
 * `launch.proxy` is ready for Playwright's launch/newContext `proxy` option;
 * `launch.args` is ready for a raw command line. Use one or the other.
 */
export function scenarioLaunch(scenarioId, lab) {
  const scenario = scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) return null;
  const launch = scenario.launch ?? {};
  const args = (launch.args ?? []).map((argument) => resolveTemplate(argument, lab));

  let proxy = null;
  let proxyCredentials = null;
  if (launch.proxyFrom) {
    const handle = endpointHandle(lab, launch.proxyFrom);
    if (handle?.url) {
      proxy = { server: handle.url, bypass: launch.bypass ?? "<-loopback>" };
      if (launch.credentials && handle.credentials) {
        proxy.username = handle.credentials.username;
        proxy.password = handle.credentials.password;
        proxyCredentials = "dummy fixture credentials, generated per lab run";
      }
    }
  }

  let skipReason = null;
  if (scenario.requiresEndpoint) {
    const handle = endpointHandle(lab, scenario.requiresEndpoint);
    if (!handle?.available) {
      skipReason = `${scenario.requiresEndpoint} unavailable: ${handle?.reason ?? "not started"}`;
    }
  }

  return {
    id: scenario.id,
    description: scenario.description,
    skipReason,
    launch: {
      args,
      ignoreDefaultArgs: [...(launch.ignoreDefaultArgs ?? [])],
      proxy,
      proxyCredentials,
    },
    contextOptions: { ...scenario.contextOptions },
    webrtcPolicy: scenario.webrtcPolicy ?? null,
    proxyEndpoint: scenario.proxyEndpoint ?? null,
    proxyMode: scenario.proxyMode ?? "context",
    profileLifecycle: scenario.profileLifecycle,
    probes: [...scenario.probes],
  };
}

/** The `config` object probe.run expects for a resolved scenario. */
export function configForScenario(plan, { playwrightDefaults = true, trustLabCa = false } = {}) {
  return {
    launchArgs: [...(plan.launch.args ?? [])],
    ignoreDefaultArgs: [...(plan.launch.ignoreDefaultArgs ?? [])],
    playwrightDefaults,
    trustLabCa,
    webrtcPolicy: plan.webrtcPolicy,
    proxy: plan.proxyMode === "process" ? { mode: "process", endpoint: plan.proxyEndpoint } : { mode: "context" },
  };
}
