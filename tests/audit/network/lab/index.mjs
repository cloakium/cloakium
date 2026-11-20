import { randomBytes } from "node:crypto";
import { safeError } from "../../lib/secure-io.mjs";
import { startOrigin } from "./origin.mjs";
import { startHttpProxy } from "./proxy-http.mjs";
import { startSocks5 } from "./proxy-socks5.mjs";
import { startStun } from "./stun.mjs";
import { startDns } from "./dns.mjs";
import { startClientHelloTap } from "./tap.mjs";
import { createTlsMaterial } from "./tls.mjs";
import { startHttp2 } from "./http2.mjs";
import { startH3 } from "./h3.mjs";
import { startDoh } from "./doh.mjs";
import { startTransparentProxy } from "./transparent-proxy.mjs";
import { withDeadline } from "./util.mjs";

const CLOSE_TIMEOUT_MS = 5_000;

/** Dummy credentials, generated per lab run and clearly not a real key. */
function dummyCredentials(prefix) {
  return {
    username: `${prefix}-dummy-user`,
    password: `${prefix}-dummy-${randomBytes(8).toString("hex")}`,
  };
}

async function closeResources(resources, operation) {
  const errors = [];
  let closedResources = 0;
  for (const handle of resources.slice().reverse()) {
    try {
      await withDeadline(Promise.resolve(handle.close?.()), CLOSE_TIMEOUT_MS, operation);
      closedResources += 1;
    } catch (error) {
      errors.push(safeError(error, operation));
    }
  }
  return { closed: errors.length === 0, resources: resources.length, closedResources, errors };
}

async function bootstrap(options, resources) {
  const { tls = false, http2 = false, h3 = true, doh = true, transparentProxy = true } = options;
  const own = (handle) => {
    resources.push(handle);
    return handle;
  };

  const origin = own(await startOrigin());
  const stun = own(await startStun());
  const dns = own(await startDns());
  const tap = own(await startClientHelloTap());

  const httpCredentials = dummyCredentials("http");
  const socksCredentials = dummyCredentials("socks");

  const http = own(await startHttpProxy({ requireAuth: false }));
  const httpAuth = own(await startHttpProxy({ requireAuth: true, credentials: httpCredentials }));
  const socks5 = own(await startSocks5({ requireAuth: false }));
  const socks5Auth = own(await startSocks5({ requireAuth: true, credentials: socksCredentials }));

  let tlsMaterial = { available: false, reason: "not requested" };
  if (tls || http2) {
    tlsMaterial = await createTlsMaterial();
    if (tlsMaterial.available) resources.push(tlsMaterial);
  }

  let h2 = { available: false, reason: "not requested" };
  if (http2) {
    if (tlsMaterial.available) {
      h2 = own(await startHttp2({ tls: tlsMaterial }));
    } else {
      h2 = { available: false, reason: tlsMaterial.reason };
    }
  }

  let dohLab = { available: false, reason: "not requested" };
  if (doh) {
    const handle = await startDoh({ tls: tlsMaterial.available ? tlsMaterial : null });
    if (handle.available) dohLab = own(handle);
    else dohLab = handle;
  }

  let transparentLab = { available: false, reason: "not requested" };
  if (transparentProxy) {
    transparentLab = own(await startTransparentProxy());
  }

  let h3Lab = { available: false, reason: "not requested" };
  if (h3) {
    const handle = await startH3();
    if (handle.available) {
      h3Lab = own(handle);
    } else {
      h3Lab = handle;
      if (handle.buildHint) process.stderr.write(`[network-lab] h3 fixture unavailable: ${handle.reason}; ${handle.buildHint}\n`);
    }
  }

  let closing = null;
  const lab = {
    origin: origin.origin,
    crossOrigin: origin.crossOrigin,
    crossOriginMode: origin.crossOriginMode,
    port: origin.port,
    proxy: {
      http: { url: http.url, port: http.port, requireAuth: false, stats: http.stats },
      httpAuth: { url: httpAuth.url, port: httpAuth.port, requireAuth: true, credentials: httpCredentials, stats: httpAuth.stats },
      socks5: { url: socks5.url, port: socks5.port, requireAuth: false, stats: socks5.stats },
      socks5Auth: { url: socks5Auth.url, port: socks5Auth.port, requireAuth: true, credentials: socksCredentials, stats: socks5Auth.stats },
    },
    stun: { host: stun.host, port: stun.port, url: stun.url, stats: stun.stats },
    dns: { host: dns.host, port: dns.port, zone: dns.zone, stats: dns.stats },
    tap: { host: tap.host, port: tap.port, url: tap.url, stats: tap.stats },
    tls: {
      available: tlsMaterial.available,
      reason: tlsMaterial.available ? null : tlsMaterial.reason,
      caFile: tlsMaterial.available ? tlsMaterial.caFile : null,
    },
    http2: { available: h2.available, reason: h2.available ? null : h2.reason, url: h2.available ? h2.url : null, stats: h2.available ? h2.stats : null },
    h3: {
      available: h3Lab.available,
      reason: h3Lab.available ? null : h3Lab.reason,
      buildHint: h3Lab.buildHint ?? null,
      url: h3Lab.available ? h3Lab.url : null,
      origin: h3Lab.available ? h3Lab.origin : null,
      udpPort: h3Lab.available ? h3Lab.udpPort : null,
      tcpPort: h3Lab.available ? (h3Lab.tcpPort ?? null) : null,
      spkiSha256: h3Lab.available ? h3Lab.spkiSha256 : null,
      certPath: h3Lab.available ? h3Lab.certPath : null,
      forceQuicOrigin: h3Lab.available ? h3Lab.forceQuicOrigin : null,
      stats: h3Lab.available ? h3Lab.stats : null,
    },
    h3Available: h3Lab.available,
    doh: {
      available: dohLab.available,
      reason: dohLab.available ? null : dohLab.reason,
      url: dohLab.available ? dohLab.url : null,
      template: dohLab.available ? dohLab.template : null,
      port: dohLab.available ? dohLab.port : null,
      zone: dohLab.available ? dohLab.zone : null,
      spkiSha256: dohLab.available ? dohLab.spkiSha256 : null,
      certPath: dohLab.available ? dohLab.certPath : null,
      caFile: dohLab.available ? dohLab.caFile : null,
      stats: dohLab.available ? dohLab.stats : null,
    },
    transparentProxy: {
      available: transparentLab.available,
      reason: transparentLab.available ? null : transparentLab.reason,
      url: transparentLab.available ? transparentLab.url : null,
      port: transparentLab.available ? transparentLab.port : null,
      stats: transparentLab.available ? transparentLab.stats : null,
    },
    originStats: origin.stats,
    endpoints: [
      { name: "origin", url: origin.origin },
      { name: "cross-origin", url: origin.crossOrigin },
      { name: "http-proxy", url: http.url },
      { name: "http-proxy-auth", url: httpAuth.url },
      { name: "socks5-proxy", url: socks5.url },
      { name: "socks5-proxy-auth", url: socks5Auth.url },
      { name: "stun", url: stun.url },
      { name: "dns", url: `udp://${dns.host}:${dns.port}` },
      { name: "clienthello-tap", url: tap.url },
      ...(h3Lab.available ? [{ name: "h3", url: h3Lab.url }] : []),
      ...(dohLab.available ? [{ name: "doh", url: dohLab.url }] : []),
      ...(transparentLab.available ? [{ name: "transparent-proxy", url: transparentLab.url }] : []),
      ...(tlsMaterial.available ? [{ name: "lab-ca", url: `file://${tlsMaterial.caFile}` }] : []),
      ...(h2.available ? [{ name: "http2", url: h2.url }] : []),
    ],
    /** Idempotent, bounded close. Returns { closed, resources, closedResources, errors }. */
    async close() {
      if (closing) return closing;
      closing = closeResources(resources, "lab close");
      return closing;
    },
  };

  return lab;
}

/**
 * Start every owned local resource on loopback, ephemeral ports. A startup
 * failure rolls back whatever already started and never returns a partial lab.
 */
export async function startLab(options = {}) {
  const resources = [];
  try {
    return await bootstrap(options, resources);
  } catch (error) {
    const rollback = await closeResources(resources, "lab startup rollback");
    throw Object.assign(new Error("Fixture lab failed to start"), {
      auditError: safeError(error, "lab start"),
      fixtureCleanup: rollback,
    });
  }
}
