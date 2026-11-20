import {
  deltaCounters,
  fail,
  fetchJson,
  gatherIce,
  inconclusive,
  navigateExpectingFailure,
  pass,
  remaining,
  result,
  stageNeeded,
  unsupported,
  withProxyContext,
} from "./kit.mjs";

const SOCKS_AUTH_UNSUPPORTED = /does not support socks5 proxy authentication/i;

const newPorts = (before, after) => {
  const previous = new Set(before.sourcePorts ?? []);
  return (after.sourcePorts ?? []).filter((port) => !previous.has(port));
};

export const probes = [
  {
    id: "net.socks5.connect-routing",
    family: "network-socks5",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.socks5"],
      launchArgs: ["--proxy-server=<lab.proxy.socks5.url>", "--proxy-bypass-list=<-loopback>"],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.socks5", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      needs: "process-level SOCKS5 so TCP routing and hostname ATYP are observed without launcher refusals",
    },
    async run({ context, browser, origin, lab, config, deadline }) {
      const before = lab.proxy.socks5.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.socks5" },
        async (scoped) => {
          const page = await scoped.newPage();
          const body = await fetchJson(page, `${origin}/echo?probe=socks5`);
          await page.close().catch(() => {});
          return body;
        },
      );
      const after = lab.proxy.socks5.stats();
      const delta = deltaCounters(before, after);
      void remaining(deadline, 1_000);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyMode: outcome.mode, proxyDelta: delta },
          checks: [stageNeeded("socks5-route-available", outcome.skipped)],
          limitations: ["No SOCKS5 route was available."],
        });
      }
      if (delta.connects === 0) {
        return result({
          observations: { proxyMode: outcome.mode, proxyDelta: delta, originBody: outcome.value, offeredMethods: after.offeredMethods },
          checks: [
            stageNeeded(
              "socks5-connect-used",
              "no SOCKS5 CONNECT reached the fixture proxy; run the `socks5` scenario with --proxy-server and <-loopback>",
            ),
          ],
          limitations: ["SOCKS5 routing was not exercised."],
        });
      }

      const body = outcome.value ?? {};
      const domainTargets = (after.targets ?? []).filter((entry) => entry.cmd === "connect" && entry.atyp === 3).length;
      const domainAtvps = after.atypCounts?.domain ?? 0;

      return result({
        observations: {
          proxyMode: outcome.mode,
          proxyDelta: delta,
          offeredMethods: after.offeredMethods,
          atypCounts: after.atypCounts,
          hostHeader: body.headers?.host ?? null,
          targets: after.targets.slice(-5),
        },
        checks: [
          pass("socks5-connect-used", `connects=${delta.connects}`),
          domainAtvps > 0
            ? pass("socks5-target-sent-as-hostname", `domain atyp=${domainAtvps}; name resolution was delegated to the proxy`)
            : fail(
                "socks5-target-sent-as-hostname",
                `atypCounts=${JSON.stringify(after.atypCounts)}; an IPv4 atyp means the browser resolved the name locally`,
              ),
          body.headers?.host === new URL(origin).host
            ? pass("origin-received-original-host", `host=${body.headers.host}`)
            : fail("origin-received-original-host", `expected ${new URL(origin).host}, got ${body.headers?.host ?? "none"}`),
          domainTargets > 0
            ? pass("proxy-recorded-hostname-target", `${domainTargets} hostname CONNECT(s)`)
            : inconclusive("proxy-recorded-hostname-target", "no hostname CONNECT in the retained window"),
        ],
        limitations: [
          "SOCKS5 hostname targets are the remote-DNS observable available to a launcher; the OS resolver is never reconfigured.",
        ],
      });
    },
  },
  {
    id: "net.socks5.userpass-auth",
    family: "network-socks5",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.socks5Auth"],
      launchArgs: [
        "--proxy-server=socks5://<dummy-user>:<dummy-pass>@127.0.0.1:<lab.proxy.socks5Auth.port>",
        "--proxy-bypass-list=<-loopback>",
      ],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.socks5Auth", credentials: true, bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      needs: "INLINE dummy credentials in --proxy-server (scenario `socks5-auth-inline`); asserts RFC 1929 offer, auth acceptance and real navigation",
    },
    async run({ context, browser, origin, lab, config, deadline }) {
      const before = lab.proxy.socks5Auth.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.socks5Auth" },
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, `${origin}/echo?probe=socks5-auth`, remaining(deadline, 8_000));
          let body = null;
          if (!navigation.failed) {
            body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => null);
          }
          await page.close().catch(() => {});
          return { navigation, body };
        },
      );
      const after = lab.proxy.socks5Auth.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        const playwrightLimit = SOCKS_AUTH_UNSUPPORTED.test(outcome.skipped);
        return result({
          observations: { skipped: outcome.skipped, proxyMode: outcome.mode, proxyDelta: delta },
          checks: [
            playwrightLimit
              ? stageNeeded(
                  "socks5-auth-route-available",
                  "Playwright refuses SOCKS5 credentials; use the raw inline --proxy-server form (scenario `socks5-auth-inline`)",
                )
              : stageNeeded("socks5-auth-route-available", outcome.skipped),
          ],
          limitations: ["The inline process-level route was not used, so the capability is untested in this run."],
        });
      }

      const offeredUserPass = (after.offeredMethods?.["2"] ?? 0) > 0;
      const navigation = outcome.value?.navigation ?? null;
      const echoBody = (() => {
        try {
          return JSON.parse(outcome.value?.body ?? "null");
        } catch {
          return null;
        }
      })();

      const checks = [];
      const inlineRejected = /ERR_NO_SUPPORTED_PROXIES/.test(navigation?.error ?? "");
      const greetingObserved = delta.greetings > 0;
      const authenticated = delta.authOk > 0;
      const navigationOk = navigation && navigation.failed === false && echoBody?.headers?.host === new URL(origin).host;

      if (!greetingObserved && inlineRejected) {
        checks.push(
          unsupported(
            "socks5-inline-credentials-accepted",
            "the proxy URL carrying inline credentials was rejected before any SOCKS negotiation (ERR_NO_SUPPORTED_PROXIES); this build does not parse credentials in --proxy-server",
          ),
        );
        checks.push(unsupported("socks5-offers-userpass-method", "no greeting was sent, so no method offer exists to evaluate"));
        checks.push(inconclusive("socks5-userpass-accepted", "not attempted: the proxy URL was rejected"));
        checks.push(inconclusive("socks5-authenticated-navigation", "not attempted: the proxy URL was rejected"));
        checks.push(inconclusive("socks5-authenticated-connect", "not attempted: the proxy URL was rejected"));
      } else {
        checks.push(
          greetingObserved
            ? pass("socks5-greeting-observed", `greetings=${delta.greetings}`)
            : fail("socks5-greeting-observed", "no SOCKS5 greeting reached the authenticated fixture"),
        );
        if (offeredUserPass) {
          checks.push(pass("socks5-offers-userpass-method", "RFC 1929 method 0x02 offered by the browser"));
        } else {
          checks.push(
            unsupported(
              "socks5-offers-userpass-method",
              `browser offered ${JSON.stringify(after.offeredMethods)}; inline credentials were not applied to the SOCKS5 greeting by this build`,
            ),
          );
        }
        checks.push(
          authenticated
            ? pass("socks5-userpass-accepted", `authOk=${delta.authOk}`)
            : offeredUserPass
              ? fail("socks5-userpass-accepted", `authOk=0 authFail=${delta.authFail}`)
              : inconclusive("socks5-userpass-accepted", "auth was never attempted because method 0x02 was not offered"),
        );
        checks.push(
          navigationOk
            ? pass("socks5-authenticated-navigation", `origin reached with host=${echoBody.headers.host}`)
            : offeredUserPass
              ? fail(
                  "socks5-authenticated-navigation",
                  `navigation=${navigation?.failed ? navigation.error : "no body"}; an authenticated CONNECT did not carry a real request`,
                )
              : inconclusive("socks5-authenticated-navigation", "no authenticated session was available to navigate with"),
        );
        checks.push(
          delta.connects > 0
            ? pass("socks5-authenticated-connect", `connects=${delta.connects}`)
            : authenticated
              ? fail("socks5-authenticated-connect", "no CONNECT after successful auth")
              : inconclusive("socks5-authenticated-connect", "no authenticated CONNECT was attempted"),
        );
      }

      return result({
        observations: {
          proxyMode: outcome.mode,
          proxyDelta: delta,
          offeredMethods: after.offeredMethods,
          navigation,
          inlineFlagRejected: inlineRejected && !greetingObserved,
          originHost: echoBody?.headers?.host ?? null,
          credentialsNote: "dummy fixture credentials generated per lab run; redacted by the runner",
        },
        checks,
        limitations: [
          "'unsupported-by-target' here means this build either rejected the inline-credential proxy URL or did not offer method 0x02; it is launcher-level evidence, not a claim that the protocol is unimplementable.",
          "The fixture server is proven to enforce RFC 1929 by selfcheck (wrong credentials are rejected) and by the no-credential negative-control probe.",
          "Chromium has no documented --proxy-server credential syntax; a launcher-level auth path (a caller-supplied proxy route) is required for this capability to be exercised.",
        ],
      });
    },
  },
  {
    id: "net.socks5.auth-negative-control",
    family: "network-socks5",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.socks5Auth"],
      launchArgs: ["--proxy-server=<lab.proxy.socks5.url-auth>", "--proxy-bypass-list=<-loopback>"],
      launchArgsAbsent: ["inline credentials"],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.socks5Auth", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      needs: "same auth-required server reached WITHOUT credentials (scenario `socks5-auth`); proves the requirement is enforced",
    },
    async run({ context, browser, origin, lab, config, deadline }) {
      const before = lab.proxy.socks5Auth.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.socks5Auth" },
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, `${origin}/`, remaining(deadline, 6_000));
          await page.close().catch(() => {});
          return navigation;
        },
      );
      const after = lab.proxy.socks5Auth.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyDelta: delta },
          checks: [stageNeeded("socks5-negative-route-available", outcome.skipped)],
          limitations: ["No unauthenticated SOCKS5 route was available."],
        });
      }

      const refused = delta.authFail > 0 || Object.keys(after.offeredMethods ?? {}).length === 0;
      const navigation = outcome.value ?? {};

      return result({
        observations: {
          proxyDelta: delta,
          offeredMethods: after.offeredMethods,
          navigation,
          credentialsNote: "no credentials supplied on purpose",
        },
        checks: [
          delta.greetings > 0
            ? pass("socks5-greeting-observed", `greetings=${delta.greetings}`)
            : fail("socks5-greeting-observed", "no greeting reached the auth-required fixture"),
          refused
            ? pass("auth-requirement-enforced", `authFail=${delta.authFail} offered=${JSON.stringify(after.offeredMethods)}`)
            : fail("auth-requirement-enforced", "the server accepted an unauthenticated client"),
          navigation.failed
            ? pass("navigation-refused-without-credentials", navigation.error ?? "navigation failed")
            : fail("navigation-refused-without-credentials", "navigation succeeded against an auth-required SOCKS5 server"),
          delta.authOk === 0
            ? pass("no-authenticated-session", "authOk stayed at 0")
            : fail("no-authenticated-session", `authOk=${delta.authOk}`),
        ],
        limitations: [
          "This is the enforcement control for the capability probe; both together distinguish 'not enforced' from 'not offered'.",
        ],
      });
    },
  },
  {
    id: "net.socks5.udp-associate-no-bypass",
    family: "network-socks5",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.socks5", "lab.stun"],
      launchArgs: ["--proxy-server=<lab.proxy.socks5.url>", "--proxy-bypass-list=<-loopback>"],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.socks5", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      precondition: "net.webrtc.stun-positive-control",
      needs: "SOCKS5 route plus WebRTC gathering; UDP attribution compares STUN source ports with the fixture relay's upstream ports",
    },
    async run({ context, browser, lab, config, deadline }) {
      const before = { proxy: lab.proxy.socks5.stats(), stun: lab.stun.stats() };
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.socks5" },
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/`, { waitUntil: "domcontentloaded" });
          const gathered = await gatherIce(page, { stunUrl: lab.stun.url, timeoutMs: remaining(deadline, 6_000) });
          await page.close().catch(() => {});
          return gathered;
        },
      );
      const after = { proxy: lab.proxy.socks5.stats(), stun: lab.stun.stats() };
      const proxyDelta = deltaCounters(before.proxy, after.proxy);
      const stunDelta = deltaCounters(before.stun, after.stun);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyDelta, stunDelta },
          checks: [stageNeeded("socks5-udp-route-available", outcome.skipped)],
          limitations: ["No SOCKS5 route was available."],
        });
      }

      const gathering = outcome.value ?? {};
      const relayPortSet = new Set((after.proxy.relayPorts ?? []).map((entry) => entry.upstreamPort));
      const observedStunPorts = newPorts(before.stun, after.stun);
      const relayedPorts = observedStunPorts.filter((port) => relayPortSet.has(port));
      const directPorts = observedStunPorts.filter((port) => !relayPortSet.has(port));
      const associate = proxyDelta.udpAssociateRequests ?? 0;
      const clientDatagrams = proxyDelta.udpDatagrams ?? 0;
      const relayed = proxyDelta.udpRelayed ?? 0;
      const stunRequests = stunDelta.requests ?? 0;
      const control =
        config?.positiveControl ??
        (config?.priorResults?.["net.webrtc.stun-positive-control"] === "pass" ? true : null);

      const checks = [
        clientDatagrams > 0 && relayed > 0
          ? pass("udp-relayed-through-socks5", `clientDatagrams=${clientDatagrams} relayed=${relayed}`)
          : associate > 0
            ? inconclusive("udp-relayed-through-socks5", `association opened but relayed datagrams=${relayed}`)
            : inconclusive("udp-relayed-through-socks5", "no UDP ASSOCIATE was issued, so no relay path exists to observe"),
      ];

      if (stunRequests > 0 && directPorts.length > 0) {
        checks.push(
          fail(
            "no-direct-udp-bypass",
            `STUN arrived from non-relay port(s) ${directPorts.join(",")} while SOCKS5 was configured; UDP left without the proxy`,
          ),
        );
      } else if (stunRequests > 0 && relayedPorts.length > 0) {
        checks.push(
          pass(
            "no-direct-udp-bypass",
            `all ${stunRequests} STUN request(s) came from relay upstream port(s) ${relayedPorts.join(",")}`,
          ),
        );
      } else if (stunRequests > 0) {
        checks.push(
          inconclusive(
            "no-direct-udp-bypass",
            `STUN arrived from port(s) ${observedStunPorts.join(",")} that are neither a relay port nor attributable; attribution is ambiguous`,
          ),
        );
      } else {
        checks.push(
          inconclusive(
            "no-direct-udp-bypass",
            control === true
              ? "no STUN traffic at the responder while the direct-path positive control passed earlier: UDP is blocked or unused, not proven proxied"
              : "no STUN traffic and no positive control in this run: blocked, unused, or unmeasured are indistinguishable",
          ),
        );
      }

      checks.push(
        relayedPorts.length > 0 && directPorts.length === 0 && stunRequests > 0
          ? pass("udp-path-classified-proxied", `relayPorts=${relayedPorts.join(",")}`)
          : directPorts.length > 0
            ? fail("udp-path-classified-proxied", `directPorts=${directPorts.join(",")}`)
            : inconclusive("udp-path-classified-proxied", "no attributable UDP path was observed"),
      );

      const attempted = (gathering.candidates?.length ?? 0) > 0 || gathering.settled === "complete";
      checks.push(
        attempted
          ? pass("ice-gathering-attempted", `settled=${gathering.settled ?? "unknown"}`)
          : inconclusive("ice-gathering-attempted", "ICE gathering produced no candidates and never completed"),
      );

      return result({
        observations: {
          proxyMode: outcome.mode,
          proxyDelta,
          stunDelta,
          attribution: {
            observedStunPorts,
            relayUpstreamPorts: [...relayPortSet],
            relayedPorts,
            directPorts,
            relayPortRecords: (after.proxy.relayPorts ?? []).slice(-8),
          },
          settled: gathering.settled ?? null,
          candidateTypes: gathering.candidateTypes ?? [],
          localCandidateStats: gathering.stats ?? [],
          webrtcPolicy: config?.webrtcPolicy ?? null,
          positiveControl: control,
        },
        checks,
        limitations: [
          "Attribution rule: a target observes the relay's upstream socket port for relayed datagrams, so STUN sources are compared against lab.proxy.socks5.stats().relayPorts[].upstreamPort.",
          "A pass proves the observed STUN came through the relay; it does not prove remote destinations would be unreachable outside it.",
          "Zero STUN traffic is reported as blocked-or-unknown, never as a proxy capability claim; net.webrtc.stun-positive-control supplies the instrument proof.",
          "The STUN responder is loopback-only; candidate strings alone are never treated as evidence of egress.",
        ],
      });
    },
  },
];
