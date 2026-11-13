/**
 * Egress IP discovery for the GeoIP path.
 *
 * The address comes from `CLOAKIUM_GEOIP_IP` or one HTTPS/HTTP echo endpoint,
 * directly or through the configured proxy. No database is ever downloaded.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";

import { GeoipLookupError } from "../errors.js";
import type { ProxyConfig } from "../proxy.js";
import { isSocksProxy } from "../proxy.js";

export const GEOIP_IP_ENV = "CLOAKIUM_GEOIP_IP";
export const GEOIP_ECHO_ENV = "CLOAKIUM_GEOIP_ECHO_URL";
export const DEFAULT_ECHO_URL = "https://api.ipify.org";

const importOptional = (specifier: string): Promise<any> => import(specifier);

const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_RANGES.some((pattern) => pattern.test(ip));
  const normalised = ip.toLowerCase();
  return normalised === "::1" || normalised.startsWith("fc") || normalised.startsWith("fd") || normalised.startsWith("fe80:");
}

function explicitIp(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[GEOIP_IP_ENV];
  if (value === undefined || value.length === 0) return undefined;
  if (!net.isIP(value)) {
    throw new GeoipLookupError(
      `[cloakium] ${GEOIP_IP_ENV}=${JSON.stringify(value)} is not an IP address`,
    );
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GeoipLookupError(`[cloakium] ${what} timed out after ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { body += chunk; });
    stream.on("end", () => resolve(body));
    stream.on("error", reject);
  });
}

function requireIp(body: string, source: string): string {
  const value = body.trim();
  if (!net.isIP(value)) {
    throw new GeoipLookupError(
      `[cloakium] ${source} did not return an IP address (got ${JSON.stringify(value.slice(0, 64))})`,
    );
  }
  return value;
}

/** `http:` or `https:` client, so a local HTTP echo endpoint works. */
function clientFor(echoUrl: string): typeof http | typeof https {
  let protocol: string;
  try {
    protocol = new URL(echoUrl).protocol;
  } catch {
    throw new GeoipLookupError(
      `[cloakium] ${GEOIP_ECHO_ENV}=${JSON.stringify(echoUrl)} is not a URL`,
    );
  }
  if (protocol === "http:") return http;
  if (protocol === "https:") return https;
  throw new GeoipLookupError(
    `[cloakium] ${GEOIP_ECHO_ENV} must use http or https, got ${protocol}`,
  );
}

async function directIp(echoUrl: string, timeoutMs: number): Promise<string> {
  const client = clientFor(echoUrl);
  const body = await withTimeout(
    new Promise<string>((resolve, reject) => {
      const request = client.get(echoUrl, { timeout: timeoutMs }, (response) => {
        readBody(response).then(resolve, reject);
      });
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("timeout")));
    }),
    timeoutMs,
    "egress IP lookup",
  );
  return requireIp(body, echoUrl);
}

async function httpProxyIp(proxy: ProxyConfig, echoUrl: string, timeoutMs: number): Promise<string> {
  const target = new URL(echoUrl);
  if (target.protocol !== "https:") {
    throw new GeoipLookupError("[cloakium] the GeoIP echo URL must use https");
  }
  const proxyUrl = new URL(proxy.server);
  const headers: Record<string, string> = { Host: `${target.hostname}:443` };
  if (proxy.username) {
    const credentials = `${proxy.username}:${proxy.password ?? ""}`;
    headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  return withTimeout(
    new Promise<string>((resolve, reject) => {
      const client = proxyUrl.protocol === "https:" ? https : http;
      const connect = client.request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80)),
        method: "CONNECT",
        path: `${target.hostname}:443`,
        headers,
        timeout: timeoutMs,
      });
      connect.on("connect", (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new GeoipLookupError(
            `[cloakium] proxy CONNECT failed with HTTP ${response.statusCode ?? "?"}`,
          ));
          return;
        }
        // agent:false keeps each launch on its own tunnel; a pooled socket
        // would report a previous proxy's exit address.
        const request = https.request(
          echoUrl,
          { socket, agent: false, timeout: timeoutMs } as https.RequestOptions,
          (res) => { readBody(res).then(resolve, reject); },
        );
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("timeout")));
        request.end();
      });
      connect.on("error", reject);
      connect.on("timeout", () => connect.destroy(new Error("timeout")));
      connect.end();
    }),
    timeoutMs,
    "proxy egress IP lookup",
  ).then((body) => requireIp(body, "proxy echo response"));
}

async function socksProxyIp(proxy: ProxyConfig, echoUrl: string, timeoutMs: number): Promise<string> {
  const client = clientFor(echoUrl);
  let SocksAgent: any;
  try {
    const mod = await importOptional("socks-proxy-agent");
    SocksAgent = mod.SocksProxyAgent ?? mod.default;
  } catch {
    throw new GeoipLookupError(
      "[cloakium] resolving the egress IP through a SOCKS proxy needs the optional " +
        "`socks-proxy-agent` peer, or set CLOAKIUM_GEOIP_IP explicitly.",
    );
  }
  const agent = new SocksAgent(proxy.server);
  const body = await withTimeout(
    new Promise<string>((resolve, reject) => {
      const request = client.get(echoUrl, { agent, timeout: timeoutMs }, (response) => {
        readBody(response).then(resolve, reject);
      });
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("timeout")));
    }),
    timeoutMs,
    "SOCKS egress IP lookup",
  );
  return requireIp(body, echoUrl);
}

/** Discover the egress IP used by `proxy` (or the host when absent). */
export async function resolveEgressIp(
  proxy: ProxyConfig | undefined,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = explicitIp(env);
  if (explicit !== undefined) return explicit;

  const echoUrl = env[GEOIP_ECHO_ENV] && env[GEOIP_ECHO_ENV].length > 0
    ? env[GEOIP_ECHO_ENV]
    : DEFAULT_ECHO_URL;

  const discovered = !proxy
    ? await directIp(echoUrl, timeoutMs)
    : isSocksProxy(proxy)
      ? await socksProxyIp(proxy, echoUrl, timeoutMs)
      : await httpProxyIp(proxy, echoUrl, timeoutMs);

  // A hijacked or intercepted echo answering with a private address would
  // otherwise resolve to a bogus country. An explicit IP may be private.
  if (isPrivateIp(discovered)) {
    throw new GeoipLookupError(
      `[cloakium] the discovered egress IP ${discovered} is private or loopback; ` +
        `set ${GEOIP_IP_ENV} to the real egress address or fix ${GEOIP_ECHO_ENV}`,
    );
  }
  return discovered;
}
