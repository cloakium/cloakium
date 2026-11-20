// Extended network scenarios: DoH routing, intercepting-proxy request form and a
// forced-policy WebRTC shape. Every probe is the network family's own descriptor;
// this module only adds launch plans, so the fixtures stay read-only here.

import {
  startLab as startNetworkLab, probes, scenarioLaunch as networkScenarioLaunch,
  configForScenario,
} from "../network/index.mjs";

export { probes, configForScenario };

export const startLab = (options) => startNetworkLab({
  ...options, h3: false, http2: false, doh: true, transparentProxy: true,
});

export const scenarioIds = [
  "doh-standard", "doh-launcher-route", "transparent-baseline",
  "transparent-local", "transparent-doh", "rtc-positive", "socks5-webrtc-forced",
];

/**
 * Extra launcher arguments are the caller's decision: `options.launcherArgs` is a
 * map of scenario id to `--flag` list, so no build-specific switch name is baked in.
 */
export function scenarioLaunch(id, lab, options = {}) {
  if (!scenarioIds.includes(id)) return null;
  const original = id.startsWith("doh-") ? "doh"
    : id.startsWith("transparent-") ? "transparent-proxy"
      : id === "rtc-positive" ? "default" : "socks5-webrtc-forced";
  const plan = networkScenarioLaunch(original, lab);
  plan.id = id;
  const extra = options.launcherArgs?.[id] ?? [];
  plan.launch.args.push(...extra);

  if ((id === "doh-launcher-route" || id === "transparent-doh") && !lab.doh?.available) {
    plan.skipReason = "Loopback DoH fixture unavailable";
  }
  if (id === "transparent-doh" && lab.doh?.available) {
    plan.probes.push("net.doh.resolution");
    plan.launch.args.push(`--ignore-certificate-errors-spki-list=${lab.doh.spkiSha256}`);
  }
  if (id === "rtc-positive") {
    plan.launch.args.push("--fingerprint-webrtc-ip=203.0.113.9");
    plan.probes = ["net.webrtc.stun-positive-control"];
  }
  return plan;
}
