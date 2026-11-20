import {
  deltaCounters,
  fail,
  inconclusive,
  navigateExpectingFailure,
  pass,
  remaining,
  result,
  stageNeeded,
  withProbeContext,
} from "./kit.mjs";

const SECRET_KEY = /key|secret|password|token/i;

export const probes = [
  {
    id: "net.tls.clienthello-metadata",
    family: "network-tls",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.tap"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "direct reachability to the loopback ClientHello tap; no certificate trust is required",
    },
    async run({ context, browser, lab, deadline }) {
      const before = lab.tap.stats();
      const target = lab.tap.url;
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, target, remaining(deadline, 6_000));
          const agent = await page.evaluate(() => navigator.userAgent).catch(() => null);
          await page.close().catch(() => {});
          return { navigation, agent };
        },
        { browser },
      );
      const after = lab.tap.stats();
      const delta = deltaCounters(before, after);
      const observed = delta.captured > 0 ? after.last : null;

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, tapDelta: delta },
          checks: [stageNeeded("tls-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }
      if (!observed) {
        return result({
          observations: { tapDelta: delta, navigation: outcome.value?.navigation ?? null, target },
          checks: [
            stageNeeded(
              "clienthello-captured",
              "no ClientHello reached the tap; check loopback reachability for the target browser",
            ),
          ],
          limitations: ["No TLS metadata was observable."],
        });
      }

      const secretFree = Object.keys(after).every((name) => !SECRET_KEY.test(name));
      return result({
        observations: {
          tapDelta: delta,
          target,
          sni: observed.sni,
          alpn: observed.alpn,
          supportedVersions: observed.supportedVersions,
          recordVersion: observed.recordVersion,
          clientVersion: observed.clientVersion,
          cipherCount: observed.cipherCount,
          cipherSample: observed.cipherSample,
          extensionTypes: observed.extensionTypes,
          groups: observed.groups,
          ja3: observed.ja3,
          ja3Hash: observed.ja3Hash,
          uaClaimed: outcome.value?.agent ?? null,
          navigation: outcome.value?.navigation ?? null,
        },
        checks: [
          pass("clienthello-captured", `captures=${delta.captured}`),
          observed.sni === "localhost"
            ? pass("sni-matches-requested-host", `sni=${observed.sni}`)
            : fail("sni-matches-requested-host", `sni=${observed.sni ?? "absent"}`),
          observed.alpn?.includes("h2")
            ? pass("alpn-offers-h2", `alpn=${observed.alpn.join(",")}`)
            : fail("alpn-offers-h2", `alpn=${observed.alpn?.join(",") || "none"}`),
          observed.supportedVersions?.includes("0304")
            ? pass("tls13-offered", `supported_versions=${observed.supportedVersions.join(",")}`)
            : fail("tls13-offered", `supported_versions=${observed.supportedVersions?.join(",") || "none"}`),
          observed.recordVersion === "0301"
            ? pass("record-legacy-version-0301", "TLS 1.3 ClientHello uses the 0x0301 compatibility record version")
            : fail("record-legacy-version-0301", `recordVersion=${observed.recordVersion}`),
          /^[0-9a-f]{32}$/.test(observed.ja3Hash ?? "")
            ? pass("ja3-fingerprint-computed", `ja3Hash=${observed.ja3Hash}`)
            : fail("ja3-fingerprint-computed", "no ja3 hash produced"),
          secretFree
            ? pass("tap-evidence-has-no-secret-material", "metadata keys only")
            : fail("tap-evidence-has-no-secret-material", "a secret-looking key appeared in tap stats"),
          observed.randomZeroed
            ? inconclusive("clienthello-random-nonzero", "client random was all zeroes")
            : pass("clienthello-random-nonzero", "client random present"),
        ],
        limitations: [
          "Only presence and shape are asserted; this is not a claim that the observed ClientHello equals any other build's.",
          "The tap records the first ClientHello on a loopback socket; no handshake completes and no key material exists.",
          "A UA-version to TLS-parameter mismatch is an observation, never an identity verdict.",
        ],
      });
    },
  },
  {
    id: "net.tls.http2-negotiation",
    family: "network-tls",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.http2", "lab.tls"],
      launchArgs: [],
      contextOptions: { ignoreHTTPSErrors: true },
      profileLifecycle: "none",
      relaunch: false,
      needs: "startLab({ http2: true }); lab CA may be trusted by the launcher instead of ignoring HTTPS errors",
    },
    async run({ context, browser, lab, config, deadline }) {
      if (!lab.http2.available) {
        return result({
          observations: { http2: lab.http2 },
          checks: [
            stageNeeded(
              "http2-lab-available",
              lab.http2.reason ?? "HTTP/2 fixture not started; call startLab({ http2: true })",
            ),
          ],
          limitations: ["HTTP/2 observability needs the TLS+HTTP/2 fixture."],
        });
      }

      const before = lab.http2.stats();
      const outcome = await withProbeContext(
        context,
        { ignoreHTTPSErrors: !config?.trustLabCa },
        async (scoped) => {
          const page = await scoped.newPage();
          const response = await page.goto(lab.http2.url, { waitUntil: "domcontentloaded", timeout: remaining(deadline, 10_000) });
          const navigation = await page.evaluate(() => {
            const entries = performance.getEntriesByType("navigation");
            return entries.length ? { nextHopProtocol: entries[0].nextHopProtocol } : null;
          });
          await page.close().catch(() => {});
          return { status: response?.status() ?? null, navigation };
        },
        { browser },
      );
      const after = lab.http2.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, http2Delta: delta },
          checks: [stageNeeded("http2-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }
      if (delta.streams === 0) {
        return result({
          observations: { http2Delta: delta, value: outcome.value },
          checks: [stageNeeded("http2-request-received", "no HTTP/2 stream reached the fixture")],
          limitations: ["The browser did not negotiate HTTP/2 with the fixture."],
        });
      }

      const navigation = outcome.value?.navigation;
      return result({
        observations: { http2Delta: delta, alpn: after.alpn, status: outcome.value?.status ?? null, navigation },
        checks: [
          pass("http2-request-received", `streams=${delta.streams}`),
          (after.alpn?.h2 ?? 0) > 0
            ? pass("server-alpn-h2", `alpn=${JSON.stringify(after.alpn)}`)
            : fail("server-alpn-h2", `alpn=${JSON.stringify(after.alpn)}`),
          navigation?.nextHopProtocol === "h2"
            ? pass("next-hop-protocol-h2", "performance navigation entry reports h2")
            : fail("next-hop-protocol-h2", `nextHopProtocol=${navigation?.nextHopProtocol ?? "unavailable"}`),
        ],
        limitations: [
          "ignoreHTTPSErrors is used only when config.trustLabCa is false; the lab CA file is available to a launcher that can trust it.",
          "ALPN/stream evidence is per-fixture, not a statement about upstream Chrome defaults.",
        ],
      });
    },
  },
];
