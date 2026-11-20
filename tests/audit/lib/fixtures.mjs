// Shared HTTP origin fixture for probe-only suites.
//
// Probe-only suites (fingerprint, wire-identity, browser-contracts, additional)
// must observe the SAME loopback origin across every configuration of a plan,
// because origin-scoped rendering mixes the security origin (host:port). This
// helper owns one origin for the whole plan; a run may borrow it, and only its
// owner closes it.
//
// Port policy: `port: 0` discovers one ephemeral port for the plan. An explicit
// port is replay-only and must come from a prior receipt; if it is occupied the
// fixture refuses instead of killing the foreign listener or silently choosing
// another origin.

import net from 'node:net';
import { hashValue } from './hashes.mjs';
import { safeError } from './secure-io.mjs';
import { startOrigin } from '../network/lab/origin.mjs';

export const SHARED_FIXTURE_SCHEMA = 'cloakium.audit.shared-probe-fixture/1';
export const SHARED_FIXTURE_OWNERSHIP = 'audit-runner';

function isLoopbackUrl(value) {
  return typeof value === 'string'
    && /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(value)
    && !/\/\/[^/]*@/.test(value);
}

/** Probe a port with a real bind; resolves true when the port is free. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function refusal(code, detail) {
  return Object.assign(new Error(`shared probe fixture refused: ${detail}`), { code });
}

/**
 * Start the one plan-wide probe origin.
 * @param {{port?: number}} [options] `0` (default) discovers; an explicit port is
 *   only for replay and must be free.
 * @param {{originFactory?: Function}} [dependencies] injection for tests only.
 */
export async function startSharedProbeFixture({ port = 0 } = {}, dependencies = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw refusal('shared-fixture-invalid-port', `port must be an integer in 0..65535, received ${String(port)}`);
  }
  const originFactory = dependencies.originFactory ?? startOrigin;

  if (port !== 0) {
    const free = await portIsFree(port);
    if (!free) throw refusal('shared-fixture-port-unavailable', `requested replay port ${port} is already in use`);
  }

  let origin;
  try {
    origin = port === 0 ? await originFactory() : await originFactory({ port });
  } catch (error) {
    throw Object.assign(refusal('shared-fixture-bind-failed', 'the origin fixture could not bind its loopback port'), {
      auditError: safeError(error, 'shared fixture bind')
    });
  }

  const actualPort = origin.port;
  if (port !== 0 && actualPort !== port) {
    await Promise.resolve(origin.close?.()).catch(() => {});
    throw refusal('shared-fixture-port-mismatch', `requested ${port} but the fixture bound ${actualPort}`);
  }
  if (!Number.isInteger(actualPort) || actualPort <= 0
    || !isLoopbackUrl(origin.origin) || !isLoopbackUrl(origin.crossOrigin)) {
    await Promise.resolve(origin.close?.()).catch(() => {});
    throw refusal('shared-fixture-not-loopback', 'the fixture did not report loopback-only HTTP origins');
  }

  const receipt = {
    schema: SHARED_FIXTURE_SCHEMA,
    ownership: SHARED_FIXTURE_OWNERSHIP,
    requestedPort: port,
    port: actualPort,
    urls: { origin: origin.origin, crossOrigin: origin.crossOrigin, crossOriginMode: origin.crossOriginMode },
    sha256: hashValue({
      origin: origin.origin,
      crossOrigin: origin.crossOrigin,
      crossOriginMode: origin.crossOriginMode,
      port: actualPort
    }),
    loopbackOnly: true
  };

  let closing = null;
  let closeReceipt = null;
  return {
    schema: SHARED_FIXTURE_SCHEMA,
    ownership: SHARED_FIXTURE_OWNERSHIP,
    origin: origin.origin,
    crossOrigin: origin.crossOrigin,
    crossOriginMode: origin.crossOriginMode,
    port: actualPort,
    originStats: () => origin.stats(),
    endpoints: [
      { name: 'origin', url: origin.origin },
      { name: 'cross-origin', url: origin.crossOrigin }
    ],
    receipt,
    /** Owner-only, idempotent close with a bounded receipt. */
    close() {
      if (closing) return closing;
      closing = (async () => {
        let closed = true;
        let error = null;
        try {
          await origin.close();
        } catch (caught) {
          closed = false;
          error = safeError(caught, 'shared fixture close');
        }
        closeReceipt = { ...receipt, closed, ...(error ? { error } : {}) };
        return closeReceipt;
      })();
      return closing;
    }
  };
}
