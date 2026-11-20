// Request-level egress attribution for the request-path probes.
//
// Counter windows alone cannot prove a request used a proxy: a proxy may count a
// rejected target while the observed request went direct. The fixtures therefore
// record accepted proxy connections (destination + local upstream port + lifetime)
// and the origin records the peer port/time of the request it actually served.
// A request is "proxied" only when the origin's peer port matches an accepted
// connection to that exact destination within the same monotonic wall clock.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_SKEW_MS = 500;

function normalizeHost(host) {
  const text = String(host ?? '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1);
  return text;
}

function splitAuthority(authority) {
  const text = String(authority ?? '').trim();
  if (!text) return null;
  const matched = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (matched) return { host: matched[1], port: matched[2] ? Number(matched[2]) : null };
  const index = text.lastIndexOf(':');
  if (index > 0) return { host: text.slice(0, index), port: Number(text.slice(index + 1)) || null };
  return { host: text, port: null };
}

function sameHost(left, right) {
  const a = normalizeHost(left);
  const b = normalizeHost(right);
  if (a === b) return true;
  return LOOPBACK_HOSTS.has(a) && LOOPBACK_HOSTS.has(b);
}

function recordWithin(record, receivedAt, skewMs) {
  if (!Number.isFinite(record?.connectedAt) || record.connectedAt > receivedAt + skewMs) return false;
  if (record.closedAt === null || record.closedAt === undefined) return true;
  return Number.isFinite(record.closedAt) && record.closedAt >= receivedAt - skewMs;
}

function publicRecord(record) {
  return {
    kind: record.kind,
    targetHost: record.targetHost,
    targetPort: record.targetPort,
    localPort: record.localPort,
    openedAt: record.openedAt ?? null,
    connectedAt: record.connectedAt ?? null,
    closedAt: record.closedAt ?? null,
    path: record.path ?? null,
    auth: record.auth ?? 'unknown'
  };
}

/** Counter-window classification kept for callers without a witness. */
export function classifyLegacy({ delta = {}, proxyUrl = null, receipt = null } = {}) {
  if (!receipt) return { mode: 'unknown', signal: 'no-origin-receipt', count: 0 };
  let scheme = null;
  try {
    scheme = proxyUrl ? new URL(proxyUrl).protocol : null;
  } catch {
    scheme = null;
  }
  if (scheme === 'socks5:') {
    const count = delta.connects ?? 0;
    return count > 0
      ? { mode: 'proxied', signal: 'socks5-connects', count }
      : { mode: 'direct', signal: 'no-socks5-connect', count: 0 };
  }
  const absolute = delta.absoluteRequests ?? 0;
  if (absolute > 0) return { mode: 'proxied', signal: 'http-absolute-requests', count: absolute };
  const tunnelled = delta.connects ?? 0;
  if (tunnelled > 0) return { mode: 'proxied', signal: 'http-connect-tunnels', count: tunnelled };
  return { mode: 'direct', signal: 'no-http-proxy-activity', count: 0 };
}

/**
 * Request/connection correlation using the origin receipt and accepted records.
 * @returns {{mode:'proxied'|'direct'|'unknown', method:string, reason:string|null,
 *   scope:string, count:number, correlation:object}}
 */
export function correlateAttribution({ body = null, witness = null, skewMs = DEFAULT_SKEW_MS } = {}) {
  const base = {
    scope: 'request-connection',
    count: 0,
    correlation: {
      peerPort: body?.peerPort ?? null,
      receivedAt: body?.receivedAt ?? null,
      expected: null,
      matched: null,
      candidates: 0,
      records: 0,
      coverage: witness?.coverage ?? null
    }
  };
  const unknown = (method, reason) => ({
    ...base,
    mode: 'unknown',
    method,
    reason,
    correlation: { ...base.correlation, expected: base.correlation.expected }
  });

  const records = Array.isArray(witness?.accepted) ? witness.accepted : null;
  const coverage = witness?.coverage ?? null;
  if (!records || !coverage) return unknown('witness-missing', 'no accepted-connection witness');
  base.correlation.records = records.length;

  if (!Number.isFinite(body?.peerPort) || !Number.isFinite(body?.receivedAt)) {
    return unknown('missing-origin-peer', 'origin receipt lacks peerPort/receivedAt');
  }
  const authority = splitAuthority(body?.host ?? body?.headers?.host);
  if (!authority?.port) return unknown('missing-expected-target', 'origin receipt lacks a host:port authority');
  const expected = {
    host: normalizeHost(authority.host),
    port: authority.port,
    path: body?.path ? `${body.path}${body.search ?? ''}` : null
  };
  base.correlation.expected = expected;

  if (coverage.complete !== true) return unknown('witness-coverage-incomplete', 'accepted-connection witness is truncated or incomplete');

  const candidates = records.filter((record) => sameHost(record.targetHost, expected.host) && record.targetPort === expected.port);
  base.correlation.candidates = candidates.length;
  const match = candidates.find((record) => {
    if (record.localPort !== body.peerPort) return false;
    if (!recordWithin(record, body.receivedAt, skewMs)) return false;
    if (record.kind === 'absolute' && expected.path && record.path && record.path !== expected.path) return false;
    return true;
  });

  if (match) {
    return {
      ...base,
      mode: 'proxied',
      method: `${match.kind}-peer-port-target${match.kind === 'absolute' ? '-path' : ''}`,
      reason: null,
      count: 1,
      correlation: { ...base.correlation, matched: publicRecord(match) }
    };
  }

  // The observed peer port belongs to an accepted connection, but not to the
  // expected destination: attribution is ambiguous (possible port reuse).
  const portRecords = records.filter((record) => record.localPort === body.peerPort);
  if (portRecords.some((record) => recordWithin(record, body.receivedAt, skewMs))) {
    return unknown('peer-port-ambiguous-target', 'origin peer port matched an accepted connection to a different destination');
  }
  if (portRecords.length) {
    return unknown('connection-window-expired', 'the matching accepted connection had already closed before the origin received the request');
  }

  // Coverage is complete and the origin peer port is not any accepted proxy
  // connection: this request did not use the proxy.
  return {
    ...base,
    mode: 'direct',
    method: 'origin-peer-not-proxied',
    reason: null,
    count: 0,
    correlation: { ...base.correlation, matched: null }
  };
}
