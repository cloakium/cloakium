import dgram from "node:dgram";
import { listenUdp, wallNow } from "./util.mjs";
import { buildResponse, parseQuery } from "./dns-wire.mjs";

/**
 * Minimal RFC 1035 A-record resolver that records queries.
 * Chromium resolves through the OS resolver, so this listener is only
 * reachable when the launcher maps DNS explicitly; probes treat an unused
 * listener as an explicit limitation rather than as evidence of anything.
 */
export async function startDns({ zone = "lab.test", answer = "127.0.0.1" } = {}) {
  const socket = dgram.createSocket("udp4");
  const queries = [];
  const counters = { queries: 0, answered: 0, nxdomain: 0, malformed: 0 };

  socket.on("error", () => {});
  socket.on("message", (message, rinfo) => {
    const query = parseQuery(message);
    if (!query) {
      counters.malformed += 1;
      return;
    }
    counters.queries += 1;
    const { response, answered } = buildResponse(message, query, { zone, answer });
    if (answered) counters.answered += 1;
    else counters.nxdomain += 1;
    queries.push({ at: wallNow(), name: query.name, type: query.type, answered, transport: "udp" });
    socket.send(response, rinfo.port, rinfo.address, () => {});
  });

  const port = await listenUdp(socket);

  return {
    host: "127.0.0.1",
    port,
    zone,
    stats() {
      return { ...counters, queries: queries.slice(-50) };
    },
    async close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}
