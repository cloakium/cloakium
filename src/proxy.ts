/**
 * Proxy normalisation for Playwright's own proxy support.
 *
 * Playwright installs and authenticates the proxy, so `--proxy-server` never
 * carries credentials and `context.request()` stays proxied. SOCKS endpoints
 * cannot be authenticated this way, so credentials there are a hard error.
 */

import { ProxyAuthUnsupportedError } from "./errors.js";
import { redactUrlCredentials } from "./redact.js";
import type { ProxyConfigInput } from "./types.js";

export interface ProxyConfig {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export function ensureProxyScheme(value: string): string {
  return value.includes("://") ? value : `http://${value}`;
}

/** SOCKS4/5 (and the remote-DNS `h` variants) cannot carry credentials. */
export function isSocksProxy(proxy: string | ProxyConfig | null | undefined): boolean {
  if (!proxy) return false;
  const server = typeof proxy === "string" ? proxy : proxy.server;
  return /^socks[45]h?:\/\//i.test(server);
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function unusable(detail: string): ProxyAuthUnsupportedError {
  return new ProxyAuthUnsupportedError(
    `[cloakium] ${detail}; expected http://host:port, https://host:port or socks5://host:port`,
  );
}

interface SplitServer {
  server: string;
  username?: string;
  password?: string;
}

/** Move credentials out of a server string; never return userinfo in it. */
function splitServer(server: string): SplitServer {
  try {
    const url = new URL(ensureProxyScheme(server));
    const username = url.username ? percentDecode(url.username) : undefined;
    const password = url.password ? percentDecode(url.password) : undefined;
    url.username = "";
    url.password = "";
    return {
      server: url.toString(),
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  } catch {
    const safe = stripTrailingSlash(ensureProxyScheme(server));
    if (safe !== stripTrailingSlash(ensureProxyScheme(redactUrlCredentials(server)))) {
      // Credentials are embedded in something that is not a parseable URL.
      throw unusable(`cannot parse proxy ${JSON.stringify(redactUrlCredentials(server))}`);
    }
    return { server: safe };
  }
}

function assemble(
  server: string,
  username: string | undefined,
  password: string | undefined,
  bypass: string | undefined,
): ProxyConfig {
  const safe = stripTrailingSlash(splitServer(server).server);
  // Last line of defence: userinfo must never reach Playwright's switch parser.
  if (redactUrlCredentials(safe) !== safe) {
    throw unusable("proxy server still contains credentials");
  }

  const proxy: ProxyConfig = { server: safe };
  if (bypass) proxy.bypass = bypass;

  if (isSocksProxy(proxy)) {
    if (username || password) {
      throw new ProxyAuthUnsupportedError(
        `[cloakium] SOCKS proxy ${safe} cannot carry credentials; terminate SOCKS ` +
          "authentication at the proxy or use an HTTP(S) proxy",
      );
    }
    return proxy;
  }
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return proxy;
}

/**
 * Turn a URL string or a Playwright proxy object into a proxy object. URL
 * userinfo is moved into `username`/`password`, so `server` never has any.
 */
export function parseProxy(
  proxy: string | ProxyConfigInput | null | undefined,
): ProxyConfig | undefined {
  if (proxy === null || proxy === undefined) return undefined;

  if (typeof proxy === "string") {
    if (proxy.length === 0) return undefined;
    let url: URL;
    try {
      url = new URL(ensureProxyScheme(proxy));
    } catch {
      throw unusable(`cannot parse proxy ${JSON.stringify(redactUrlCredentials(proxy))}`);
    }
    if (!url.hostname) {
      throw unusable(`proxy ${JSON.stringify(redactUrlCredentials(proxy))} has no hostname`);
    }
    const username = url.username ? percentDecode(url.username) : undefined;
    const password = url.password ? percentDecode(url.password) : undefined;
    url.username = "";
    url.password = "";
    return assemble(url.toString(), username, password, undefined);
  }

  if (!proxy.server) {
    throw unusable("proxy object is missing `server`");
  }
  const embedded = splitServer(proxy.server);
  return assemble(
    embedded.server,
    proxy.username ?? embedded.username,
    proxy.password ?? embedded.password,
    proxy.bypass,
  );
}

/** Launch-time proxy option: `{}` when no proxy is configured. */
export function resolveProxyConfig(
  proxy: string | ProxyConfigInput | null | undefined,
): { proxy?: ProxyConfig } {
  const parsed = parseProxy(proxy);
  return parsed === undefined ? {} : { proxy: parsed };
}

/** Credential values that must never appear in a diagnostic. */
export function proxySecrets(proxy: unknown): string[] {
  let parsed: ProxyConfig | undefined;
  try {
    parsed = parseProxy(proxy as string | ProxyConfigInput | undefined);
  } catch {
    return [];
  }
  if (parsed === undefined) return [];
  return [parsed.username, parsed.password].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
