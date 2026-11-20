import http from "node:http";
import net from "node:net";
import {
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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Interception-style proxy control: accepts BOTH request forms and records which
 * one arrived:
 *   - origin-form  `GET /path` with `Host:`   (what a network-intercepted proxy sees)
 *   - absolute-form `GET http://host/path`    (what an explicitly configured proxy sends)
 * That distinction is the whole point: the fixture reports what the build actually does.
 */
export async function startTransparentProxy({ via = "1.1 cloakium-lab-transparent" } = {}) {
  const counters = { originForm: 0, absoluteForm: 0, connects: 0, forwarded: 0, blockedExternal: 0, selfLoops: 0, malformed: 0 };
  const targets = [];
  const sockets = new Set();
  let boundPort = 0;

  const allow = (host) => {
    const normalized = normalizeHost(host).toLowerCase();
    return LOOPBACK.has(normalized) || normalized === "lab.test" || normalized.endsWith(".lab.test");
  };
  const resolveTarget = (host) => {
    const normalized = normalizeHost(host).toLowerCase();
    return normalized === "lab.test" || normalized.endsWith(".lab.test") ? "127.0.0.1" : normalized;
  };
  const note = (form, host, port, path) => {
    const description = describeTarget(host, port);
    if (description.external) return description;
    targets.push({ form, host: description.host, port, path, at: wallNow() });
    while (targets.length > 64) targets.shift();
    return description;
  };

  const server = http.createServer((request, response) => {
    let form = null;
    let target = null;
    try {
      if (/^https?:\/\//i.test(request.url ?? "")) {
        form = "absolute";
        target = new URL(request.url);
      } else {
        form = "origin";
        const host = request.headers.host;
        if (!host) {
          counters.malformed += 1;
          response.writeHead(400, { "content-length": 0 }).end();
          return;
        }
        target = new URL(`http://${host}${request.url}`);
      }
    } catch {
      counters.malformed += 1;
      response.writeHead(400, { "content-length": 0 }).end();
      return;
    }

    const port = Number(target.port || 80);
    if (form === "absolute") counters.absoluteForm += 1;
    else counters.originForm += 1;
    const described = note(form, target.hostname, port, target.pathname);

    if (described.external || !allow(target.hostname)) {
      counters.blockedExternal += 1;
      response.writeHead(403, { "content-length": 0 }).end();
      return;
    }
    if (port === boundPort && port !== 0) {
      counters.selfLoops += 1;
      response.writeHead(508, { "content-length": 0 }).end();
      return;
    }

    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(name)) headers[name] = value;
    }
    if (via) headers.via = via;

    const upstream = http.request({
      host: resolveTarget(target.hostname),
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    });
    upstream.on("response", (upstreamResponse) => {
      counters.forwarded += 1;
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-length": 0 });
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
    counters.connects += 1;
    const described = note("connect", host, targetPort, null);
    if (described.external || !allow(host)) {
      counters.blockedExternal += 1;
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: resolveTarget(host), port: targetPort });
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      closeSocket(upstream);
    });
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("close", () => closeSocket(clientSocket));
    clientSocket.on("close", () => closeSocket(upstream));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenTcp(server);
  boundPort = port;

  return {
    available: true,
    url: `http://127.0.0.1:${port}`,
    port,
    stats() {
      return { ...counters, targets: targets.slice(-32), openSockets: sockets.size };
    },
    async close() {
      for (const socket of sockets) closeSocket(socket);
      sockets.clear();
      await closeServer(server);
    },
  };
}
