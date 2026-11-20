import http2 from "node:http2";
import { closeServer, listenTcp } from "./util.mjs";

/** HTTP/2 origin over the lab TLS material, with an HTTP/1.1 fallback. */
export async function startHttp2({ tls } = {}) {
  if (!tls?.available) return { available: false, reason: "TLS material unavailable" };

  const counters = { streams: 0, http1Requests: 0 };
  const alpn = new Map();
  const server = http2.createSecureServer({ key: tls.key, cert: tls.cert, allowHTTP1: true });

  server.on("secureConnection", (socket) => {
    const protocol = socket.alpnProtocol || "none";
    alpn.set(protocol, (alpn.get(protocol) ?? 0) + 1);
  });
  server.on("stream", (stream, headers) => {
    counters.streams += 1;
    stream.respond({ ":status": 200, "content-type": "application/json", "cache-control": "no-store" });
    stream.end(
      JSON.stringify({
        protocol: "h2",
        method: headers[":method"],
        path: headers[":path"],
        authority: headers[":authority"],
      }),
    );
  });
  server.on("request", (request, response) => {
    // Node also emits 'request' for HTTP/2 streams; those are answered by 'stream'.
    if (request.stream) return;
    counters.http1Requests += 1;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ protocol: "http/1.1", path: request.url }));
  });

  const port = await listenTcp(server);
  return {
    available: true,
    url: `https://127.0.0.1:${port}`,
    port,
    stats() {
      return { ...counters, alpn: Object.fromEntries(alpn) };
    },
    async close() {
      await closeServer(server);
    },
  };
}
