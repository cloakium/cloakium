import net from "node:net";

export const LOOPBACK = "127.0.0.1";
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Private scratch directory for lab state (keys, certificates, profiles).
 * Callers may point CLOAKIUM_AUDIT_PRIVATE_ROOT at a user-private audit root;
 * the default is the pre-created agent temp root. Nothing outside it is read.
 */
export function privateRoot() {
  return process.env.CLOAKIUM_AUDIT_PRIVATE_ROOT || "/tmp/opencode";
}

/**
 * Minimal, non-secret environment for fixture helper children (openssl, the H3
 * binary). Only a fixed tool path and private scratch locations are exposed;
 * nothing is inherited from the ambient process environment.
 */
export function fixtureEnv(extra = {}) {
  const root = privateRoot();
  return {
    PATH: "/run/current-system/sw/bin:/usr/bin:/bin",
    HOME: root,
    TMPDIR: root,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...extra,
  };
}

export class LabTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "LabTimeoutError";
  }
}

/** Wall clock in ms. All lab deadlines use this, never an iteration count. */
export function wallNow() {
  return Date.now();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Rejects with LabTimeoutError once the wall-clock budget is spent. */
export async function withDeadline(work, timeoutMs, label) {
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new LabTimeoutError(`${label} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until `check()` is truthy. Bounded by wall clock, not by a loop count.
 * Returns the truthy value so callers can use the result directly.
 */
export async function waitFor(check, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 25, label = "condition" } = {}) {
  const deadline = wallNow() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    const remaining = deadline - wallNow();
    if (remaining <= 0) throw new LabTimeoutError(`${label} not satisfied within ${timeoutMs}ms`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** Bind a TCP server to an explicit loopback host and port (0 = ephemeral). */
export function listenTcpAt(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    });
  });
}

/** Bind a TCP server to an ephemeral port on an explicit loopback host. */
export function listenTcpOn(server, host) {
  return listenTcpAt(server, host, 0);
}

/** Bind a TCP server to an ephemeral port on 127.0.0.1 only. */
export function listenTcp(server) {
  return listenTcpAt(server, LOOPBACK, 0);
}

/** Bind a UDP socket to an ephemeral port on loopback only. */
export function listenUdp(socket) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.bind(0, LOOPBACK, () => {
      socket.removeListener("error", onError);
      resolve(socket.address().port);
    });
  });
}

export async function closeServer(server, timeoutMs = 2_000) {
  if (!server || !server.listening) return;
  await withDeadline(
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
    timeoutMs,
    "server close",
  ).catch(() => server.closeAllConnections?.());
}

export function closeSocket(socket) {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
}

export function normalizeHost(host) {
  const text = String(host ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) return text.slice(1, -1);
  return text;
}

export function isIpLiteral(host) {
  return net.isIP(normalizeHost(host)) !== 0;
}

/** Split `host:port` or `[v6]:port`, tolerating a missing port. */
export function splitAuthority(authority) {
  const text = String(authority ?? "");
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (match) return { host: match[1], port: match[2] ? Number(match[2]) : undefined };
  const index = text.lastIndexOf(":");
  if (index <= 0) return { host: text, port: undefined };
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) || undefined };
}

/** Decode a Basic credential header. Returns null for anything unusable. */
export function parseBasic(value) {
  if (!value) return null;
  const [scheme, encoded] = String(value).split(" ");
  if (!/^basic$/i.test(scheme ?? "") || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return null;
  return { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
}

/** Constant-shape comparison that never returns the credentials. */
export function basicMatches(value, expected) {
  const parsed = parseBasic(value);
  if (!parsed || !expected) return false;
  return parsed.username === expected.username && parsed.password === expected.password;
}

const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api-?key|license/i;

/** Header map safe to record: sensitive values become a length marker. */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) ? `<redacted:${String(value).length}b>` : String(value);
  }
  return out;
}

/**
 * Target described for evidence. External (non-loopback) targets record a
 * count only: connect metadata, never payload, never a third-party hostname.
 */
export function describeTarget(host, port) {
  const normalized = normalizeHost(host).toLowerCase();
  const loopback =
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "lab.test" ||
    normalized.endsWith(".lab.test");
  if (!loopback) return { external: true, isDomain: !isIpLiteral(normalized) };
  return { external: false, host: normalized, port, isDomain: !isIpLiteral(normalized) };
}

export function counterDelta(before, after) {
  const delta = {};
  for (const key of Object.keys(after)) {
    const a = after[key];
    const b = before[key];
    delta[key] = typeof a === "number" && typeof b === "number" ? a - b : a;
  }
  return delta;
}
