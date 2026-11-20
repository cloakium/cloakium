import http from "node:http";
import { closeServer, listenTcp, listenTcpAt, redactHeaders, wallNow } from "./util.mjs";
import {
  audioPage,
  blankPage,
  closedShadowPage,
  cookieSetterPage,
  floodPage,
  framePage,
  indexPage,
  inputPage,
  navigationPolicyPage,
  popupFloodPage,
  popupPolicyPage,
  storagePage,
  thirdPartyPage,
} from "./pages.mjs";

const LOG_LIMIT = 400;
const HIT_LIMIT = 4_000;

// Opt-in client-hint policy for the identity fixture only (standard header names,
// MDN: Sec-CH-UA-* / Accept-CH). No other route changes origin policy.
export const IDENTITY_ACCEPT_CH = [
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-Full-Version-List",
];
export const IDENTITY_ACCEPT_CH_VALUE = IDENTITY_ACCEPT_CH.join(", ");
export const IDENTITY_HIGH_ENTROPY_HEADERS = [
  "sec-ch-ua-platform-version",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version-list",
];

function identityPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>identity fixture</title></head>
<body><p id="identity-fixture" data-lab="identity">client-hint opt-in document</p></body></html>`;
}

/**
 * Loopback fixture origin. Two hostnames share one listener so probes get a
 * real cross-site peer (127.0.0.1 vs localhost) without a second server.
 *
 * `port: 0` (default) discovers an ephemeral port. An explicit port is for
 * replay of a recorded origin: a bind failure is propagated (never replaced by a
 * different port), so a plan cannot silently change its security origin.
 */
export async function startOrigin({ port: requestedPort = 0 } = {}) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`startOrigin: port must be an integer in 0..65535, received ${String(requestedPort)}`);
  }
  const hits = new Map();
  const log = [];
  const started = wallNow();

  const record = (request, extra) => {
    if (log.length >= LOG_LIMIT) log.shift();
    log.push({ at: wallNow() - started, ...extra, headers: redactHeaders(request.headers) });
  };

  const bump = (key) => {
    const next = (hits.get(key) ?? 0) + 1;
    hits.set(key, next);
    if (hits.size > HIT_LIMIT) hits.delete(hits.keys().next().value);
    return next;
  };

  let primaryPort = 0;
  const handle = (request, response) => {
    const base = `http://${request.headers.host ?? "127.0.0.1"}`;
    let url;
    try {
      url = new URL(request.url, base);
    } catch {
      response.writeHead(400).end("bad url");
      return;
    }
    const path = url.pathname;

    if (path === "/stats") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ hits: Object.fromEntries(hits), requests: log }));
      return;
    }

    if (path === "/echo") {
      record(request, { path, method: request.method });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(
        JSON.stringify({
          method: request.method,
          path,
          search: url.search,
          peerPort: request.socket.remotePort ?? null,
          receivedAt: wallNow(),
          httpVersion: request.httpVersion,
          headerNames: Object.keys(request.headers).sort(),
          headers: redactHeaders(request.headers),
        }),
      );
      return;
    }

    // Server-receipt endpoint: the wire-identity probe compares these headers
    // with the values the page and a worker see from JavaScript.
    if (path === "/headers") {
      record(request, { path, method: request.method });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Accept-CH": IDENTITY_ACCEPT_CH_VALUE,
      });
      response.end(JSON.stringify({
        policy: IDENTITY_ACCEPT_CH,
        acceptCH: IDENTITY_ACCEPT_CH_VALUE,
        headers: redactHeaders(request.headers),
        clientHints: IDENTITY_ACCEPT_CH.map((name) => ({
          name,
          value: request.headers[name.toLowerCase()] ?? null,
        })),
      }));
      return;
    }

    // Explicit opt-in document for client hints. The Accept-CH policy applies to
    // this origin only after this response; other routes never advertise it.
    if (path === "/identity") {
      record(request, { path, method: request.method });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Accept-CH": IDENTITY_ACCEPT_CH_VALUE,
        Vary: "Accept-CH",
      });
      response.end(identityPage());
      return;
    }

    if (path.startsWith("/hit/")) {
      const id = path.slice("/hit/".length) || "default";
      const mode = url.searchParams.get("mode") ?? "fresh";
      const count = bump(`/hit/${id}`);
      record(request, { path, method: request.method, mode, count });

      if (mode === "etag" && request.headers["if-none-match"] === `"lab-${id}"`) {
        response.writeHead(304, { ETag: `"lab-${id}"`, "Cache-Control": "no-cache" });
        response.end();
        return;
      }

      const headers = { "Content-Type": "application/json" };
      if (mode === "fresh") {
        headers["Cache-Control"] = `max-age=${url.searchParams.get("maxAge") ?? 120}, immutable`;
        headers.ETag = `"lab-${id}"`;
      } else if (mode === "nostore") {
        headers["Cache-Control"] = "no-store";
      } else if (mode === "etag") {
        headers["Cache-Control"] = "no-cache";
        headers.ETag = `"lab-${id}"`;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify({ id, count, mode }));
      return;
    }

    if (path === "/slow") {
      const ms = Math.min(Number(url.searchParams.get("ms") ?? 50) || 50, 5_000);
      record(request, { path, method: request.method, ms });
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end(`slept:${ms}`);
      }, ms);
      return;
    }

    if (path === "/set-cookie") {
      const name = url.searchParams.get("name") ?? "lab";
      const value = url.searchParams.get("value") ?? "1";
      const parts = [`${name}=${value}`, "Path=/"];
      if (url.searchParams.get("sameSite")) parts.push(`SameSite=${url.searchParams.get("sameSite")}`);
      if (url.searchParams.get("secure") === "1") parts.push("Secure");
      if (url.searchParams.get("partitioned") === "1") parts.push("Partitioned");
      record(request, { path, method: request.method, cookieName: name });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Set-Cookie": parts.join("; "),
      });
      response.end(JSON.stringify({ set: name, parts }));
      return;
    }

    if (path === "/cookies") {
      record(request, { path, method: request.method });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ cookie: redactHeaders({ cookie: request.headers.cookie ?? "" }).cookie }));
      return;
    }

    if (path === "/frame") {
      bump("/frame");
      record(request, { path, method: request.method });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(framePage());
      return;
    }

    if (path === "/thirdparty") {
      record(request, { path, method: request.method });
      const peer = url.searchParams.get("peer") ?? `http://localhost:${primaryPort}`;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(thirdPartyPage(peer));
      return;
    }

    if (path === "/closed-shadow") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(closedShadowPage());
      return;
    }

    if (path === "/popup-flood" || path === "/popup-target") {
      record(request, { path, method: request.method });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(path === "/popup-flood" ? popupFloodPage() : blankPage("popup target"));
      return;
    }

    if (path === "/flood") {
      record(request, { path, method: request.method });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(floodPage());
      return;
    }

    if (path === "/storage") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(storagePage());
      return;
    }

    // Routes used by the browser-contract probes: they need real HTTP documents,
    // not page.setContent priming.
    if (path === "/input" || path === "/audio" || path === "/popup" || path === "/navigation-policy") {
      record(request, { path, method: request.method });
      const body = path === "/input" ? inputPage()
        : path === "/audio" ? audioPage()
          : path === "/popup" ? popupPolicyPage()
            : navigationPolicyPage();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(body);
      return;
    }

    if (path === "/cookie-setter") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(cookieSetterPage());
      return;
    }

    bump("/");
    record(request, { path, method: request.method });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(indexPage());
  };

  const upgradeHandler = (_request, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
  };

  const primary = http.createServer(handle);
  primary.on("upgrade", upgradeHandler);
  const port = await listenTcpAt(primary, "127.0.0.1", requestedPort);
  if (requestedPort !== 0 && port !== requestedPort) {
    await closeServer(primary);
    throw new Error(`startOrigin: requested port ${requestedPort} but bound ${port}`);
  }
  primaryPort = port;

  // A distinct site for cross-site probes: IPv6 loopback on the same port when
  // available, otherwise an ephemeral IPv6 port, otherwise localhost.
  let secondary;
  let crossOrigin;
  let crossOriginMode;
  const bindSecondary = async (host, candidate) => {
    const server = http.createServer(handle);
    server.on("upgrade", upgradeHandler);
    const bound = await listenTcpAt(server, host, candidate);
    return { server, bound };
  };
  try {
    const attempt = await bindSecondary("::1", port);
    secondary = attempt.server;
    crossOrigin = `http://[::1]:${attempt.bound}`;
    crossOriginMode = "ipv6-loopback-same-port";
  } catch {
    try {
      const attempt = await bindSecondary("::1", 0);
      secondary = attempt.server;
      crossOrigin = `http://[::1]:${attempt.bound}`;
      crossOriginMode = "ipv6-loopback";
    } catch {
      const attempt = await bindSecondary("127.0.0.1", 0);
      secondary = attempt.server;
      crossOrigin = `http://localhost:${attempt.bound}`;
      crossOriginMode = "localhost-fallback";
    }
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    crossOrigin,
    crossOriginMode,
    port,
    stats() {
      return {
        origin: `http://127.0.0.1:${port}`,
        crossOrigin,
        crossOriginMode,
        hits: Object.fromEntries(hits),
        total: [...hits.values()].reduce((sum, value) => sum + value, 0),
        requests: log.slice(),
      };
    },
    async close() {
      await Promise.all([closeServer(primary), closeServer(secondary)]);
    },
  };
}
