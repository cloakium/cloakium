/** DoH (RFC 8484) and transparent-proxy control checks, kept out of the main runner. */
import { X509Certificate, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { withDeadline } from "../lab/util.mjs";

function request({ port, path, method, headers, body, ca }) {
  const client = ca ? https : http;
  return withDeadline(
    new Promise((resolve, reject) => {
      const call = client.request({ host: "127.0.0.1", port, path, method, headers, ca }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, type: response.headers["content-type"], body: Buffer.concat(chunks) }));
      });
      call.on("error", reject);
      call.end(body);
    }),
    5_000,
    `${method ?? "GET"} ${path}`,
  );
}

export async function checkDoh({ lab, record, dnsQuery }) {
  if (!lab.doh?.available) {
    record("doh.post-rfc8484", false, lab.doh?.reason ?? "unavailable");
    return;
  }
  const ca = await readFile(lab.doh.caFile ?? lab.doh.certPath);

  const post = async (name) => {
    const body = dnsQuery(name);
    return request({
      port: lab.doh.port,
      path: "/dns-query",
      method: "POST",
      ca,
      headers: { "content-type": "application/dns-message", "content-length": body.length },
      body,
    });
  };
  const get = (name) =>
    request({ port: lab.doh.port, path: `/dns-query?dns=${dnsQuery(name).toString("base64url")}`, method: "GET", ca });

  const posted = await post("dohpost.lab.test");
  record(
    "doh.post-rfc8484",
    posted.status === 200 &&
      posted.type === "application/dns-message" &&
      posted.body.readUInt16BE(6) === 1 &&
      posted.body.subarray(-4).join(".") === "127.0.0.1",
    `status=${posted.status} answers=${posted.body.readUInt16BE(6)}`,
  );

  const fetched = await get("dohget.lab.test");
  record(
    "doh.get-base64url",
    fetched.status === 200 && fetched.body.readUInt16BE(6) === 1,
    `status=${fetched.status} answers=${fetched.body.readUInt16BE(6)}`,
  );

  const stats = lab.doh.stats();
  record("doh.records-queries", stats.requests >= 2 && stats.answered >= 2, `requests=${stats.requests} answered=${stats.answered}`);
  record("doh.records-tls-handshakes",
    stats.tcpConnections >= 1 && stats.secureConnections >= 1 && stats.tlsClientErrors === 0,
    `tcp=${stats.tcpConnections} secure=${stats.secureConnections} errors=${stats.tlsClientErrors}`);

  const pem = await readFile(lab.doh.certPath, "utf8");
  const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  const pin = createHash("sha256").update(spki).digest("base64");
  record("doh.spki-pin-matches-certificate", pin === lab.doh.spkiSha256, `pin=${(lab.doh.spkiSha256 ?? "").slice(0, 10)}…`);
}

export async function checkTransparentProxy({ lab, record }) {
  if (!lab.transparentProxy?.available) {
    record("transparent.origin-form", false, lab.transparentProxy?.reason ?? "unavailable");
    return;
  }
  const forward = (path, host) =>
    request({ port: lab.transparentProxy.port, path, headers: { host } }).then((result) => result.status);

  const originStatus = await forward("/echo", `127.0.0.1:${lab.port}`);
  const absoluteStatus = await forward(`${lab.origin}/echo`, `127.0.0.1:${lab.port}`);
  const loopStatus = await forward("/echo", `127.0.0.1:${lab.transparentProxy.port}`);
  const stats = lab.transparentProxy.stats();

  record("transparent.origin-form", originStatus === 200 && stats.originForm >= 1, `status=${originStatus} originForm=${stats.originForm}`);
  record("transparent.absolute-form", absoluteStatus === 200 && stats.absoluteForm >= 1, `status=${absoluteStatus} absoluteForm=${stats.absoluteForm}`);
  record("transparent.self-loop-guard", loopStatus === 508 && stats.selfLoops >= 1, `status=${loopStatus}`);
}
