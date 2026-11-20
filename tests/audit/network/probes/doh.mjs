import {
  fail,
  pass,
  remaining,
  result,
  stageNeeded,
  unsupported,
  withProbeContext,
  navigateExpectingFailure,
} from "./kit.mjs";

export const probes = [
  {
    id: "net.doh.resolution",
    family: "network-doh",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.doh"],
      launchArgs: [
        "--dns-over-https-mode=secure",
        "--dns-over-https-templates=<lab.doh.template>",
        "--ignore-certificate-errors-spki-list=<lab.doh.spkiSha256>",
      ],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: true,
      needs:
        "a DoH route supplied by the launcher (documented --dns-over-https-* switches shown in launchArgs) or an equivalent caller-provided DoH configuration",
    },
    async run({ context, browser, lab, config, deadline }) {
      if (!lab.doh?.available) {
        return result({
          observations: { doh: { available: false, reason: lab.doh?.reason ?? "not started" } },
          checks: [stageNeeded("doh-fixture-available", lab.doh?.reason ?? "startLab({ doh: true })")],
          limitations: ["No DoH fixture running."],
        });
      }

      const before = lab.doh.stats();
      const name = `doh-${Date.now().toString(36)}.lab.test`;
      const target = `http://${name}:${lab.port}/echo?probe=doh`;

      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, target, remaining(deadline, 12_000));
          let body = null;
          if (!navigation.failed) {
            body = await page.evaluate(() => document.body?.innerText ?? null).catch(() => null);
          }
          await page.close().catch(() => {});
          return { navigation, body };
        },
        { browser },
      );

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("doh-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const after = lab.doh.stats();
      const delta = {
        requests: (after.requests ?? 0) - (before.requests ?? 0),
        answered: (after.answered ?? 0) - (before.answered ?? 0),
        tcpConnections: (after.tcpConnections ?? 0) - (before.tcpConnections ?? 0),
        secureConnections: (after.secureConnections ?? 0) - (before.secureConnections ?? 0),
        tlsClientErrors: (after.tlsClientErrors ?? 0) - (before.tlsClientErrors ?? 0),
      };
      const navigation = outcome.value?.navigation ?? {};
      let originHost = null;
      try {
        originHost = JSON.parse(outcome.value?.body ?? "null")?.headers?.host ?? null;
      } catch {
        originHost = null;
      }

      const checks = [];
      if (delta.requests > 0) {
        checks.push(pass("doh-query-observed", `requests=${delta.requests}`));
      } else {
        checks.push(
          unsupported(
            "doh-query-observed",
            navigation.failed
              ? `no DoH query reached the fixture; navigation=${navigation.error}`
              : "no DoH query reached the fixture",
          ),
        );
      }
      checks.push(
        delta.answered > 0
          ? pass("doh-answered-zone-record", `answered=${delta.answered}`)
          : unsupported("doh-answered-zone-record", "no in-zone query was answered by the fixture"),
      );
      checks.push(
        delta.requests === 0
          ? unsupported("origin-reached-via-doh-name", "not attempted: no DoH query was issued")
          : originHost === `${name}:${lab.port}`
            ? pass("origin-reached-via-doh-name", `host=${originHost}`)
            : fail("origin-reached-via-doh-name", `host=${originHost ?? "none"}`),
      );

      return result({
        observations: {
          target,
          name,
          dohDelta: delta,
          dohQueries: after.queries ?? [],
          tlsErrorCodes: after.tlsErrorCodes ?? [],
          navigation,
          originHost,
          dohMode: config?.dohMode ?? null,
          template: lab.doh.template,
          note: "loopback DoH only; no remote resolver was contacted",
        },
        checks,
        limitations: [
          "Only special-use .lab.test names are served; nothing public is resolved.",
          "If the target ignores the documented DoH switches the probe reports unsupported-by-target: that is a capability outcome, not a fixture failure. The fixture is ready for any launcher-provided DoH route.",
          "The fixture certificate is pinned by SPKI; no trust-store change and no blanket certificate ignore.",
        ],
      });
    },
  },
];
