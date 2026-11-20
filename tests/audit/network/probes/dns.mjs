import { lookup } from "node:dns/promises";
import {
  deltaCounters,
  fail,
  fetchJson,
  inconclusive,
  pass,
  result,
  stageNeeded,
  withProxyContext,
} from "./kit.mjs";

export const probes = [
  {
    id: "net.dns.remote-resolution",
    family: "network-dns",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.http", "lab.port"],
      launchArgs: ["--proxy-server=<lab.proxy.http.url>", "--proxy-bypass-list=<-loopback>"],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.http", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: false,
      needs: "an HTTP proxy route so a locally unresolvable .lab.test name is resolved by the proxy",
    },
    async run({ context, browser, lab, config }) {
      const name = `dns-${Date.now().toString(36)}.lab.test`;
      const target = `http://${name}:${lab.port}/echo?probe=dns`;
      const before = lab.proxy.http.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.http" },
        async (scoped) => {
          const page = await scoped.newPage();
          const body = await fetchJson(page, target);
          await page.close().catch(() => {});
          return body;
        },
      );
      const after = lab.proxy.http.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyDelta: delta, target },
          checks: [stageNeeded("dns-proxy-route-available", outcome.skipped)],
          limitations: ["Without a proxy route there is no remote resolver in the lab."],
        });
      }
      if (delta.absoluteRequests === 0) {
        return result({
          observations: { proxyDelta: delta, target },
          checks: [
            stageNeeded(
              "proxy-received-hostname",
              "the request never reached the fixture proxy; a successful fetch would then prove nothing about remote DNS",
            ),
          ],
          limitations: ["No proxy traffic observed, so remote DNS is unproven."],
        });
      }

      const body = outcome.value ?? {};
      let localResolution = "unexpected-success";
      try {
        await lookup(name);
      } catch (error) {
        localResolution = error.code ?? "error";
      }

      const hostnameTarget = (after.targets ?? []).some((entry) => entry.host === name);
      const checks = [
        body.headers?.host === `${name}:${lab.port}`
          ? pass("origin-received-unresolvable-name", `host=${body.headers.host}`)
          : fail("origin-received-unresolvable-name", `host=${body.headers?.host ?? "none"}`),
        localResolution === "ENOTFOUND" || localResolution === "EAI_AGAIN" || localResolution === "ENODATA"
          ? pass("local-resolution-negative-control", `system resolver returned ${localResolution}`)
          : inconclusive(
              "local-resolution-negative-control",
              `system resolver answered "${localResolution}", so the fetch does not discriminate remote from direct DNS`,
            ),
        hostnameTarget
          ? pass("proxy-observed-hostname", `proxy target host=${name}`)
          : inconclusive("proxy-observed-hostname", "hostname not in the retained target window"),
      ];

      checks.push(
        body.headers?.host === `${name}:${lab.port}`
          ? pass("remote-resolution-end-to-end", "request arrived through the proxy-resolved name")
          : fail("remote-resolution-end-to-end", "request did not arrive with the remote name"),
      );

      return result({
        observations: {
          proxyDelta: delta,
          target,
          localResolver: localResolution,
          labDnsQueries: lab.dns.stats().queries,
          labDnsNote: "the lab DNS recorder is not the OS resolver and is expected to stay unused",
        },
        checks,
        limitations: [
          "The lab cannot repoint the OS resolver without root or global config edits (forbidden), so remote DNS is established by the proxy receiving a locally unresolvable name.",
          "Lab DNS recorder stats are reported for completeness and are not used as evidence.",
        ],
      });
    },
  },
];
