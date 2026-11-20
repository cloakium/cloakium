import { startLab as startNetworkLab } from "../network/index.mjs";

/**
 * Thin adapter over the read-only network fixture.
 * Every call is a FRESH lab: new ephemeral ports and new dummy credentials.
 * Heavy fixtures (TLS, HTTP/2, HTTP/3, DoH, transparent proxy) stay off by default.
 */
const DEFAULTS = { tls: false, http2: false, h3: false, doh: false, transparentProxy: false };

export async function startLab(options = {}) {
  // Heavy fixtures are never needed by this suite, even if a shared runner asks for them.
  return startNetworkLab({ ...DEFAULTS, ...options, h3: false, doh: false, transparentProxy: false });
}

/** Non-secret view of the endpoints this suite uses. */
export function requestPathEndpoints(lab) {
  if (!lab) return [];
  const names = ["http", "httpAuth", "socks5", "socks5Auth"];
  return names.map((name) => {
    const handle = lab.proxy?.[name];
    return {
      endpoint: `lab.proxy.${name}`,
      url: handle?.url ?? null,
      available: Boolean(handle?.url),
      requireAuth: Boolean(handle?.requireAuth),
      credentials: handle?.requireAuth ? "dummy fixture, generated per lab run" : "none",
    };
  });
}
