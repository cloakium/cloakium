import http from "node:http";
import net from "node:net";
import { Transform } from "node:stream";
import {
  basicMatches,
  closeServer,
  closeSocket,
  describeTarget,
  listenTcp,
  normalizeHost,
  splitAuthority,
  wallNow,
} from "./util.mjs";

const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOCAL_ZONE = ".lab.test";

/** The proxy plays the remote resolver for the lab zone; nothing external. */
const resolveTarget = (host) => {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "lab.test" || normalized.endsWith(LOCAL_ZONE) ? "127.0.0.1" : normalized;
};

/**
 * HTTP forward proxy (RFC 9110 absolute-form + CONNECT).
 * Targets are restricted to loopback: the proxy structurally cannot relay
 * anywhere else, so it cannot intercept or influence other traffic.
 */
export async function startHttpProxy({ requireAuth = false, credentials = null, via = "1.1 cloakium-lab" } = {}) {
  const counters = {
    absoluteRequests: 0,
    absoluteAttempts: 0,
    connects: 0,
    connectAttempts: 0,
    authOk: 0,
    rejectedAuth: 0,
    blockedExternal: 0,
    malformedRequests: 0,
  };
  // Accepted-connection witness: destination + local upstream port + lifetime.
  // Only accepted connections are recorded; credential values are never stored.
  const accepted = [];
  const ACCEPT_LIMIT = 64;
  let acceptedTotal = 0;
  let acceptedTruncated = 0;
  const noteAccepted = (record) => {
    acceptedTotal += 1;
    if (accepted.length < ACCEPT_LIMIT) accepted.push(record);
    else acceptedTruncated += 1;
  };
  const seen = { targets: [], firstBytes: [] };
  const sockets = new Set();

  const allow = (host) => {
    const normalized = normalizeHost(host).toLowerCase();
    return LOOPBACK_HOSTS.has(normalized) || normalized === "lab.test" || normalized.endsWith(LOCAL_ZONE);
  };
  const authorize = (header) => {
    if (!requireAuth) return true;
    const ok = basicMatches(header, credentials);
    if (ok) counters.authOk += 1;
    return ok;
  };
  const noteTarget = (kind, host, port) => {
    const description = describeTarget(host, port);
    if (description.external) return description;
    seen.targets.push({ kind, ...description, at: wallNow() });
    return description;
  };

  const server = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      counters.malformedRequests += 1;
      response.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }
    if (target.protocol !== "http:") {
      counters.malformedRequests += 1;
      response.writeHead(400, { "Content-Length": "0" }).end();
      return;
    }

    const port = Number(target.port || 80);
    counters.absoluteAttempts += 1;
    const described = noteTarget("absolute", target.hostname, port);

    if (described.external || !allow(target.hostname)) {
      counters.blockedExternal += 1;
      response.writeHead(403, { "Content-Length": "0" }).end();
      return;
    }
    if (!authorize(request.headers["proxy-authorization"])) {
      counters.rejectedAuth += 1;
      response.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="cloakium-lab"',
        "Content-Length": "0",
      }).end();
      return;
    }

    counters.absoluteRequests += 1;
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(name)) headers[name] = value;
    }
    if (via) headers.via = via;

    const record = {
      kind: "absolute",
      targetHost: normalizeHost(target.hostname).toLowerCase(),
      targetPort: port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      openedAt: wallNow(),
      connectedAt: null,
      closedAt: null,
      localPort: null,
      auth: requireAuth ? "accepted" : "not-required",
    };
    let noted = false;
    const noteConnection = (socket) => {
      if (noted) return;
      noted = true;
      record.localPort = socket.localPort ?? null;
      record.connectedAt = wallNow();
      noteAccepted(record);
    };

    const upstream = http.request({
      host: resolveTarget(target.hostname),
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    });
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("socket", (socket) => {
      if (!socket.connecting) noteConnection(socket);
      else socket.once("connect", () => noteConnection(socket));
      socket.once("close", () => { record.closedAt = record.closedAt ?? wallNow(); });
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "Content-Length": "0" });
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("connect", (request, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    clientSocket.on("error", () => closeSocket(clientSocket));

    const { host, port } = splitAuthority(request.url);
    const targetPort = port ?? 443;
    const openedAt = wallNow();
    counters.connectAttempts += 1;
    const described = noteTarget("connect", host, targetPort);

    let settled = false;
    const reject = (status, headers = {}) => {
      if (settled) return;
      settled = true;
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      clientSocket.end(
        `HTTP/1.1 ${status}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}Content-Length: 0\r\n\r\n`,
      );
      closeSocket(clientSocket);
    };

    if (described.external || !allow(host)) {
      counters.blockedExternal += 1;
      reject("403 Forbidden");
      return;
    }
    if (!authorize(request.headers["proxy-authorization"])) {
      counters.rejectedAuth += 1;
      reject("407 Proxy Authentication Required", { "Proxy-Authenticate": 'Basic realm="cloakium-lab"' });
      return;
    }

    const upstream = net.connect({ host: resolveTarget(host), port: targetPort });
    upstream.on("error", () => {
      reject("502 Bad Gateway");
      closeSocket(upstream);
    });
    upstream.on("close", () => closeSocket(clientSocket));
    clientSocket.on("close", () => closeSocket(upstream));

    upstream.on("connect", () => {
      settled = true;
      counters.connects += 1;
      const record = {
        kind: "connect",
        targetHost: normalizeHost(host).toLowerCase(),
        targetPort,
        openedAt,
        connectedAt: wallNow(),
        closedAt: null,
        localPort: upstream.localPort ?? null,
        auth: requireAuth ? "accepted" : "not-required",
      };
      upstream.once("close", () => { record.closedAt = record.closedAt ?? wallNow(); });
      noteAccepted(record);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      // Tap records the first tunnel byte only: 0x16 means a TLS handshake.
      let firstByte = null;
      const tap = new Transform({
        transform(chunk, _encoding, callback) {
          if (firstByte === null) {
            firstByte = chunk[0];
            seen.firstBytes.push(firstByte);
          }
          callback(null, chunk);
        },
      });
      clientSocket.pipe(tap).pipe(upstream);
      upstream.pipe(clientSocket);
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenTcp(server);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requireAuth,
    credentials,
    stats() {
      return {
        ...counters,
        targets: seen.targets.slice(-50),
        accepted: accepted.slice(),
        acceptedTotal,
        acceptedTruncated,
        coverage: { complete: acceptedTruncated === 0, records: accepted.length, total: acceptedTotal, truncated: acceptedTruncated },
        tunnelConnections: seen.firstBytes.length,
        tunnelTlsHandshake: seen.firstBytes.filter((byte) => byte === 0x16).length,
        openSockets: sockets.size,
      };
    },
    async close() {
      for (const socket of sockets) closeSocket(socket);
      sockets.clear();
      await closeServer(server);
    },
  };
}
