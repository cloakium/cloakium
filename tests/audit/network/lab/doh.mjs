import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { closeServer, listenTcp, wallNow } from "./util.mjs";
import { buildResponse, parseQuery } from "./dns-wire.mjs";
import { createTlsMaterial } from "./tls.mjs";

const DNS_PATH = "/dns-query";
const MAX_BODY = 4096;
const QUERY_LIMIT = 256;

/** base64(SHA-256(DER SubjectPublicKeyInfo)) — the value Chrome's SPKI pin takes. */
export function spkiPin(certPem) {
  const certificate = new X509Certificate(certPem);
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64");
}

/**
 * RFC 8484 DNS-over-HTTPS listener on loopback.
 * Accepts GET ?dns=<base64url> and POST application/dns-message, answers
 * A records for `zone`, and records every query. HTTPS only, because Chrome
 * refuses plaintext DoH templates.
 */
export async function startDoh({ zone = "lab.test", answer = "127.0.0.1", tls = null } = {}) {
  const ownMaterial = !tls?.available;
  const material = ownMaterial ? await createTlsMaterial() : tls;
  if (!material.available) {
    return { available: false, reason: material.reason ?? "no TLS material for DoH" };
  }

  const counters = {
    requests: 0, answered: 0, nxdomain: 0, malformed: 0, badRequests: 0,
    tcpConnections: 0, secureConnections: 0, tlsClientErrors: 0,
  };
  const tlsErrorCodes = new Set();
  const queries = [];

  const record = (query, answered, transport) => {
    counters.requests += 1;
    if (answered) counters.answered += 1;
    else counters.nxdomain += 1;
    queries.push({ at: wallNow(), name: query.name, type: query.type, answered, transport });
    while (queries.length > QUERY_LIMIT) queries.shift();
  };

  const respond = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "application/dns-message",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
  };

  const handle = (request, response) => {
    if (!request.url?.startsWith(DNS_PATH)) {
      counters.badRequests += 1;
      response.writeHead(404, { "content-length": 0 }).end();
      return;
    }

    const decode = (buffer) => {
      const query = parseQuery(buffer);
      if (!query) {
        counters.malformed += 1;
        counters.badRequests += 1;
        respond(response, 400, Buffer.alloc(0));
        return;
      }
      const { response: payload, answered } = buildResponse(buffer, query, { zone, answer });
      record(query, answered, request.method);
      respond(response, 200, payload);
    };

    if (request.method === "GET") {
      const parsed = new URL(request.url, "https://doh.lab.invalid");
      const value = parsed.searchParams.get("dns");
      if (!value) {
        counters.badRequests += 1;
        respond(response, 400, Buffer.alloc(0));
        return;
      }
      decode(Buffer.from(value, "base64url"));
      return;
    }

    if (request.method === "POST") {
      if (!String(request.headers["content-type"] ?? "").includes("application/dns-message")) {
        counters.badRequests += 1;
        respond(response, 415, Buffer.alloc(0));
        return;
      }
      const chunks = [];
      let total = 0;
      request.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY) {
          counters.badRequests += 1;
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => decode(Buffer.concat(chunks)));
      return;
    }

    counters.badRequests += 1;
    response.writeHead(405, { "content-length": 0 }).end();
  };

  const server = https.createServer({ key: material.key, cert: material.cert }, handle);
  server.on('connection', () => counters.tcpConnections++);
  server.on('secureConnection', () => counters.secureConnections++);
  server.on('tlsClientError', error => {
    counters.tlsClientErrors++;
    tlsErrorCodes.add(error.code ?? 'UNKNOWN');
  });
  const port = await listenTcp(server);
  const url = `https://127.0.0.1:${port}${DNS_PATH}`;

  return {
    available: true,
    reason: null,
    url,
    template: `${url}{?dns}`,
    port,
    zone,
    spkiSha256: spkiPin(material.cert),
    certPath: material.certFile ?? null,
    caFile: material.caFile ?? null,
    stats() {
      return { ...counters, zone, url, tlsErrorCodes: [...tlsErrorCodes].sort(), queries: queries.slice(-50) };
    },
    async close() {
      await closeServer(server);
      if (ownMaterial) await material.close?.();
    },
  };
}
