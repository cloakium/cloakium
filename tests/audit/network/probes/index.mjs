import { probes as cookies } from "./cookies.mjs";
import { probes as dns } from "./dns.mjs";
import { probes as h3 } from "./h3.mjs";
import { probes as doh } from "./doh.mjs";
import { probes as transparent } from "./transparent.mjs";
import { probes as popupShadowDom } from "./popup-shadowdom.mjs";
import { probes as profileExport } from "./profile-export.mjs";
import { probes as proxyHttp } from "./proxy-http.mjs";
import { probes as socks5 } from "./socks5.mjs";
import { probes as storage } from "./storage.mjs";
import { probes as timingCache } from "./timing-cache.mjs";
import { probes as tlsH2 } from "./tls-h2.mjs";
import { probes as webrtc } from "./webrtc.mjs";

// Per-probe wall-clock ceilings. Anything longer than the default is a fixture
// that has to wait for a real protocol handshake (QUIC, DoH, CONNECT tunnels).
export const DEFAULT_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUTS = {
  "net.h3.direct-positive-control": 40_000,
  "net.h3.quic-over-socks5": 40_000,
  "net.doh.resolution": 30_000,
  "net.proxy.http.connect-auth": 30_000,
  "net.proxy.http.connect-auth-inline": 30_000,
  "net.tls.clienthello-metadata": 25_000,
  "net.tls.http2-negotiation": 25_000,
  "net.webrtc.stun-positive-control": 25_000,
  "net.socks5.udp-associate-no-bypass": 25_000,
};

export const probes = [
  ...proxyHttp,
  ...socks5,
  ...dns,
  ...h3,
  ...doh,
  ...transparent,
  ...webrtc,
  ...tlsH2,
  ...timingCache,
  ...cookies,
  ...storage,
  ...profileExport,
  ...popupShadowDom,
].map((probe) => ({
  ...probe,
  timeoutMs: probe.timeoutMs ?? PROBE_TIMEOUTS[probe.id] ?? DEFAULT_TIMEOUT_MS,
  contextOptions: { ...(probe.contextOptions ?? {}) },
}));

export const probeIds = probes.map((probe) => probe.id);

export function findProbe(id) {
  return probes.find((probe) => probe.id === id) ?? null;
}
