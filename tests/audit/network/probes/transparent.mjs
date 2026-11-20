import { fail, pass, result, stageNeeded, inconclusive, withProxyContext } from "./kit.mjs";

export const probes = [
  {
    id: "net.proxy.transparent-form",
    family: "network-proxy-transparent",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.transparentProxy"],
      launchArgs: ["--proxy-server=<lab.transparentProxy.url>", "--proxy-bypass-list=<-loopback>"],
      contextOptions: { proxy: { fromEndpoint: "lab.transparentProxy", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      needs:
        "a transparent/intercepting proxy route supplied by the launcher; the fixture accepts origin-form and absolute-form and reports which arrived",
    },
    async run({ context, browser, origin, lab, config }) {
      if (!lab.transparentProxy?.available) {
        return result({
          observations: { transparentProxy: { available: false, reason: lab.transparentProxy?.reason ?? "not started" } },
          checks: [stageNeeded("transparent-fixture-available", lab.transparentProxy?.reason ?? "startLab({ transparentProxy: true })")],
          limitations: ["No transparent-proxy fixture running."],
        });
      }

      const before = lab.transparentProxy.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.transparentProxy" },
        async (scoped) => {
          const page = await scoped.newPage();
          const response = await page.goto(`${origin}/echo?probe=transparent`, { waitUntil: "domcontentloaded" });
          const body = await response?.text();
          await page.close().catch(() => {});
          return body;
        },
      );
      const after = lab.transparentProxy.stats();
      const delta = {
        originForm: (after.originForm ?? 0) - (before.originForm ?? 0),
        absoluteForm: (after.absoluteForm ?? 0) - (before.absoluteForm ?? 0),
        connects: (after.connects ?? 0) - (before.connects ?? 0),
        forwarded: (after.forwarded ?? 0) - (before.forwarded ?? 0),
        blockedExternal: (after.blockedExternal ?? 0) - (before.blockedExternal ?? 0),
        selfLoops: (after.selfLoops ?? 0) - (before.selfLoops ?? 0),
      };

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, delta },
          checks: [stageNeeded("transparent-route-available", outcome.skipped)],
          limitations: ["No transparent-proxy route was available."],
        });
      }

      let headers = null;
      try {
        headers = JSON.parse(outcome.value ?? "null")?.headers ?? null;
      } catch {
        headers = null;
      }
      const arrived = delta.originForm + delta.absoluteForm + delta.connects;

      if (arrived === 0) {
        return result({
          observations: { delta, proxyMode: outcome.mode },
          checks: [
            stageNeeded(
              "transparent-request-arrived",
              "nothing reached the fixture; no transparent/intercepting route was active for this context",
            ),
          ],
          limitations: ["The transparent-proxy surface was not exercised, so no request form could be recorded."],
        });
      }

      const form =
        delta.originForm > 0 && delta.absoluteForm > 0
          ? "mixed"
          : delta.originForm > 0
            ? "origin-form"
            : delta.absoluteForm > 0
              ? "absolute-form"
              : "connect";

      return result({
        observations: { delta, form, proxyMode: outcome.mode, headers, targets: (after.targets ?? []).slice(-5) },
        checks: [
          pass("transparent-request-arrived", `requests=${arrived}`),
          form === "origin-form" || form === "absolute-form" || form === "mixed" || form === "connect"
            ? pass("request-form-recorded", `form=${form}`)
            : inconclusive("request-form-recorded", `form=${form}`),
          headers?.via === "1.1 cloakium-lab-transparent"
            ? pass("origin-saw-transparent-via", "origin recorded the transparent-proxy Via")
            : inconclusive("origin-saw-transparent-via", `via=${headers?.via ?? "absent"}`),
          delta.blockedExternal === 0
            ? pass("no-external-target", "no non-loopback target was attempted")
            : fail("no-external-target", `${delta.blockedExternal} non-loopback attempt(s); hostnames not recorded`),
        ],
        limitations: [
          "Origin-form can only occur when the build intercepts at the network layer; an explicit --proxy-server always produces absolute-form or CONNECT.",
          "The fixture forwards only loopback targets, so this says nothing about remote proxy behaviour.",
        ],
      });
    },
  },
];
