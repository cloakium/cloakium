import {
  deltaCounters,
  fail,
  gatherIce,
  inconclusive,
  pass,
  remaining,
  result,
  stageNeeded,
  withProbeContext,
} from "./kit.mjs";

const candidatePort = (text) => {
  const parts = String(text).split(" ");
  const port = Number(parts[5]);
  return Number.isFinite(port) ? port : null;
};

export const probes = [
  {
    id: "net.webrtc.stun-positive-control",
    family: "network-webrtc",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.stun"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "a direct (non-proxied) context so UDP to the loopback STUN responder is reachable at all",
    },
    async run({ context, browser, lab, config, deadline }) {
      const before = lab.stun.stats();
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/`, { waitUntil: "domcontentloaded" });
          const gathered = await gatherIce(page, { stunUrl: lab.stun.url, timeoutMs: remaining(deadline, 6_000) });
          await page.close().catch(() => {});
          return gathered;
        },
        { browser },
      );
      const after = lab.stun.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, stunDelta: delta },
          checks: [stageNeeded("webrtc-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const gathering = outcome.value ?? {};
      const srflx = (gathering.candidates ?? []).filter(
        (entry) => entry.type === "srflx" || / typ srflx /.test(` ${entry.text} `),
      );
      const ports = srflx.map((entry) => candidatePort(entry.text)).filter((port) => port !== null);
      const observed = new Set(after.sourcePorts ?? []);

      return result({
        observations: {
          stunDelta: delta,
          settled: gathering.settled ?? null,
          candidateTypes: gathering.candidateTypes ?? [],
          srflxPorts: ports,
          stunSourcePorts: after.sourcePorts ?? [],
          webrtcPolicy: config?.webrtcPolicy ?? null,
        },
        checks: [
          delta.requests > 0
            ? pass("stun-binding-request-observed", `requests=${delta.requests}`)
            : fail("stun-binding-request-observed", "no binding request reached the loopback STUN responder"),
          delta.responses > 0
            ? pass("stun-response-sent", `responses=${delta.responses}`)
            : fail("stun-response-sent", "responder sent no binding success"),
          srflx.length > 0
            ? pass("srflx-candidate-present", `${srflx.length} server-reflexive candidate(s)`)
            : inconclusive("srflx-candidate-present", "no srflx candidate was produced"),
          ports.some((port) => observed.has(port))
            ? pass("candidate-port-matches-observed-udp-source", `ports=${ports.join(",")}`)
            : inconclusive(
                "candidate-port-matches-observed-udp-source",
                `candidate ports=${ports.join(",") || "none"} observed=${[...observed].join(",") || "none"}`,
              ),
          after.nonLoopbackSources === 0
            ? pass("all-udp-sources-loopback", "every STUN request came from 127.0.0.1")
            : fail("all-udp-sources-loopback", `${after.nonLoopbackSources} non-loopback source(s)`),
        ],
        limitations: [
          "This is the instrument control: without STUN traffic here, a zero result in any bypass probe is meaningless.",
          "Loopback STUN maps to 127.0.0.1, so this validates measurement, not NAT traversal.",
          "A launcher webrtc policy that blocks non-proxied UDP will make this probe fail by design; run it in the direct scenario.",
        ],
      });
    },
  },
];
