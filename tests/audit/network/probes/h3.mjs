import {
  fail,
  inconclusive,
  navigateExpectingFailure,
  pass,
  remaining,
  result,
  stageNeeded,
  unsupported,
  withProbeContext,
  withProxyContext,
} from "./kit.mjs";

const multisetDelta = (before = [], after = []) => {
  const counts = new Map();
  for (const value of before) counts.set(value, (counts.get(value) ?? 0) + 1);
  const out = [];
  for (const value of after) {
    const count = counts.get(value) ?? 0;
    if (count > 0) counts.set(value, count - 1);
    else out.push(value);
  }
  return out;
};

const numericDelta = (before, after, key) => {
  const a = before?.[key];
  const b = after?.[key];
  return typeof a === "number" && typeof b === "number" ? b - a : null;
};

async function readH3(page, url, deadline) {
  const navigation = await navigateExpectingFailure(page, url, remaining(deadline, 10_000));
  let body = null;
  let nextHopProtocol = null;
  if (!navigation.failed) {
    body = await page
      .evaluate(() => {
        try {
          return JSON.parse(document.body?.innerText ?? "null");
        } catch {
          return null;
        }
      })
      .catch(() => null);
    nextHopProtocol = await page
      .evaluate(() => performance.getEntriesByType("navigation")[0]?.nextHopProtocol ?? null)
      .catch(() => null);
  }
  return { navigation, body, nextHopProtocol };
}

const unavailableResult = (lab) =>
  result({
    observations: { h3: { available: false, reason: lab.h3?.reason ?? "not started" }, buildHint: lab.h3?.buildHint ?? null },
    checks: [
      stageNeeded(
        "h3-fixture-available",
        `${lab.h3?.reason ?? "HTTP/3 fixture unavailable"}; ${lab.h3?.buildHint ?? "pass startLab({ h3: true })"}`,
      ),
    ],
    limitations: ["No HTTP/3 fixture was running, so QUIC behaviour is unobserved."],
  });

export const probes = [
  {
    id: "net.h3.direct-positive-control",
    family: "network-h3",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.h3"],
      launchArgs: [
        "--enable-quic",
        "--origin-to-force-quic-on=<lab.h3.forceQuicOrigin>",
        "--ignore-certificate-errors-spki-list=<lab.h3.spkiSha256>",
      ],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: true,
      needs: "direct (non-proxied) run first: proves the QUIC instrument before any proxied claim is evaluated",
    },
    async run({ context, browser, lab, deadline }) {
      if (!lab.h3?.available) return unavailableResult(lab);

      const before = await lab.h3.stats();
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          const observed = await readH3(page, lab.h3.url, deadline);
          await page.close().catch(() => {});
          return observed;
        },
        { browser },
      );
      const after = await lab.h3.stats();

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("h3-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const connections = numericDelta(before, after, "connections") ?? 0;
      const requests = numericDelta(before, after, "requests") ?? 0;
      const observed = outcome.value ?? {};

      return result({
        observations: {
          h3StatsDelta: { connections, requests },
          peerPorts: after.peerPorts ?? [],
          navigation: observed.navigation ?? null,
          nextHopProtocol: observed.nextHopProtocol ?? null,
          body: observed.body ?? null,
          spkiPinPresent: Boolean(lab.h3.spkiSha256),
        },
        checks: [
          connections > 0
            ? pass("quic-connection-accepted", `connections=${connections}`)
            : fail("quic-connection-accepted", "the QUIC endpoint accepted no connection"),
          requests > 0
            ? pass("h3-request-served", `requests=${requests}`)
            : fail("h3-request-served", "no HTTP/3 request reached the fixture"),
          observed.nextHopProtocol === "h3"
            ? pass("browser-negotiated-h3", "performance navigation entry reports h3")
            : fail("browser-negotiated-h3", `nextHopProtocol=${observed.nextHopProtocol ?? "unavailable"}`),
          observed.body?.protocol === "h3"
            ? pass("response-declared-h3", "fixture response reports protocol=h3")
            : fail("response-declared-h3", `body=${JSON.stringify(observed.body)}`),
        ],
        limitations: [
          "This is the instrument control: without a direct H3 success, a proxied absence is uninterpretable.",
          "The ephemeral fixture certificate is pinned by SPKI; no blanket certificate-ignore and no trust-store change is used.",
          "Loopback only; nothing about real-world QUIC NAT traversal is claimed.",
        ],
      });
    },
  },
  {
    id: "net.h3.quic-over-socks5",
    family: "network-h3",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.h3", "lab.proxy.socks5"],
      launchArgs: [
        "--enable-quic",
        "--origin-to-force-quic-on=<lab.h3.forceQuicOrigin>",
        "--ignore-certificate-errors-spki-list=<lab.h3.spkiSha256>",
        "--proxy-server=<lab.proxy.socks5.url>",
        "--proxy-bypass-list=<-loopback>",
      ],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.socks5", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      precondition: "net.h3.direct-positive-control",
      needs: "QUIC-over-SOCKS UDP claim: server peer ports are compared with the fixture relay's upstream ports",
    },
    async run({ context, browser, lab, config, deadline }) {
      if (!lab.h3?.available) return unavailableResult(lab);

      const before = { h3: await lab.h3.stats(), socks: lab.proxy.socks5.stats() };
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.socks5" },
        async (scoped) => {
          const page = await scoped.newPage();
          const observed = await readH3(page, lab.h3.url, deadline);
          // A brief ICE gather is not relevant here; keep the page idle-free.
          await page.close().catch(() => {});
          return observed;
        },
      );
      const after = { h3: await lab.h3.stats(), socks: lab.proxy.socks5.stats() };

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyMode: outcome.mode },
          checks: [stageNeeded("h3-socks-route-available", outcome.skipped)],
          limitations: ["No SOCKS5 route was available."],
        });
      }

      const observed = outcome.value ?? {};
      const newPeerPorts = multisetDelta(before.h3?.peerPorts ?? [], after.h3?.peerPorts ?? []);
      const relayUpstream = new Set((after.socks.relayPorts ?? []).map((entry) => entry.upstreamPort));
      const relayedQuic = newPeerPorts.filter((port) => relayUpstream.has(port));
      const directQuic = newPeerPorts.filter((port) => !relayUpstream.has(port));
      const connections = numericDelta(before.h3, after.h3, "connections") ?? 0;
      const requests = numericDelta(before.h3, after.h3, "requests") ?? 0;
      const associate = numericDelta(before.socks, after.socks, "udpAssociateRequests") ?? 0;
      const datagrams = numericDelta(before.socks, after.socks, "udpDatagrams") ?? 0;
      const relayed = numericDelta(before.socks, after.socks, "udpRelayed") ?? 0;
      const tcpConnects = numericDelta(before.socks, after.socks, "connects") ?? 0;
      const tcpAttempts = numericDelta(before.socks, after.socks, "connectAttempts") ?? 0;
      const tcpRequests = numericDelta(before.h3, after.h3, "tcpRequests") ?? 0;
      const negotiatedH3 = observed.nextHopProtocol === "h3" || observed.body?.protocol === "h3";
      const directControl =
        config?.priorResults?.["net.h3.direct-positive-control"] ??
        (config?.positiveControl === true ? "pass" : null);
      const control = directControl === "pass" ? true : null;

      const checks = [
        connections > 0
          ? pass("h3-connection-observed", `connections=${connections}`)
          : unsupported(
              "h3-connection-observed",
              `no QUIC connection reached the fixture through SOCKS5; navigation=${observed.navigation?.failed ? observed.navigation.error : "ok"}; tcpAttempts=${tcpAttempts} tcpServed=${tcpRequests}`,
            ),
        negotiatedH3
          ? pass("browser-negotiated-h3-through-proxy", `nextHopProtocol=${observed.nextHopProtocol ?? "unknown"}`)
          : inconclusive("browser-negotiated-h3-through-proxy", `nextHopProtocol=${observed.nextHopProtocol ?? "unavailable"}`),
        relayedQuic.length > 0 && datagrams > 0
          ? pass("quic-udp-relayed-through-socks5", `peerPorts=${relayedQuic.join(",")} relayedDatagrams=${relayed} clientDatagrams=${datagrams}`)
          : inconclusive(
              "quic-udp-relayed-through-socks5",
              `associate=${associate} clientDatagrams=${datagrams} relayed=${relayed} relayedPeerPorts=${relayedQuic.join(",") || "none"}`,
            ),
      ];

      if (newPeerPorts.length === 0) {
        checks.push(
          inconclusive(
            "no-direct-quic-bypass",
            control === true
              ? "the direct H3 control passed earlier and no QUIC peer arrived through any path: blocked or unused, not proven proxied"
              : "no QUIC peer was observed and no direct positive control exists in this run",
          ),
        );
      } else if (directQuic.length > 0) {
        checks.push(
          fail(
            "no-direct-quic-bypass",
            `QUIC peer port(s) ${directQuic.join(",")} are not relay upstream ports; UDP left without the proxy`,
          ),
        );
      } else {
        checks.push(pass("no-direct-quic-bypass", `all QUIC peers came from relay port(s) ${relayedQuic.join(",")}`));
      }

      checks.push(
        relayedQuic.length > 0 && directQuic.length === 0
          ? pass("quic-path-classified-proxied", "QUIC was carried by the SOCKS5 UDP relay")
          : directQuic.length > 0
            ? fail("quic-path-classified-proxied", `direct QUIC port(s) ${directQuic.join(",")}`)
            : inconclusive("quic-path-classified-proxied", "no attributable QUIC path was observed"),
      );

      if (!negotiatedH3) {
        checks.push(
          tcpAttempts > 0 && tcpRequests > 0
            ? pass(
                "tcp-fallback-via-proxy",
                `proxy path works: ${tcpAttempts} TCP CONNECT attempt(s) served ${tcpRequests} HTTP/1.1 response(s) (nextHopProtocol=${observed.nextHopProtocol ?? "unknown"}), while UDP ASSOCIATE stayed at ${associate}`,
              )
            : tcpAttempts > 0
              ? inconclusive(
                  "tcp-fallback-via-proxy",
                  `browser attempted ${tcpAttempts} TCP CONNECT(s) but the fixture served no HTTP/1.1 response; QUIC also absent`,
                )
              : inconclusive(
                  "tcp-fallback-via-proxy",
                  `tcpConnectAttempts=${tcpAttempts} udpAssociate=${associate}; neither path was exercised`,
                ),
        );
      }

      return result({
        observations: {
          proxyMode: outcome.mode,
          h3Delta: { connections, requests },
          socksDelta: { associate, datagrams, relayed, tcpConnects, tcpAttempts },
          h3TcpRequests: tcpRequests,
          attribution: {
            newPeerPorts,
            relayUpstreamPorts: [...relayUpstream],
            relayedQuic,
            directQuic,
            peerAddrs: after.h3?.peerAddrs ?? [],
          },
          nextHopProtocol: observed.nextHopProtocol ?? null,
          navigation: observed.navigation ?? null,
          positiveControl: control,
          webrtcPolicy: config?.webrtcPolicy ?? null,
        },
        checks,
        limitations: [
          "Attribution rule: the fixture server records each QUIC peer's UDP source port; a relayed flow shows the relay's upstream port, a bypass shows an unrelated port.",
          "A pass proves loopback QUIC travelled through the SOCKS5 UDP relay; it says nothing about remote networks.",
          "No QUIC traffic is reported as blocked-or-unknown, never as a capability claim; the direct H3 control supplies the instrument proof.",
          "Chromium may disable QUIC behind a proxy entirely; that outcome is recorded as unsupported-by-target rather than as a fixture failure.",
        ],
      });
    },
  },
];
