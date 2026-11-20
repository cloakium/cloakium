/**
 * HTTP/3 fixture selfcheck against the compiled Rust tool (tools/audit-h3-lab).
 *
 * Exercises the parts a Node client can reach without a QUIC stack: the startup
 * contract, the loopback control channel, and the TCP/HTTP1.1 fallback listener
 * that shares the UDP port number. QUIC itself is measured by the probes with a
 * real browser; here the fixture either skips (not built) or proves its shape.
 */
import https from "node:https";
import { readFile } from "node:fs/promises";
import { X509Certificate, createHash } from "node:crypto";
import { startH3 } from "../lab/h3.mjs";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}\n`);
}

function httpGetTls({ port, ca }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: "127.0.0.1", port, path: "/fixture", method: "GET", ca, servername: "localhost", timeout: 5_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("tls client timeout")));
    request.on("error", reject);
    request.end();
  });
}

const fixture = await startH3();
if (!fixture.available) {
  process.stdout.write(`SKIP h3 fixture not built: ${fixture.reason}\n${fixture.buildHint ?? ""}\n`);
} else {
  try {
    record("startup.udp-port", Number.isInteger(fixture.udpPort) && fixture.udpPort > 0, `port=${fixture.udpPort}`);
    record("startup.control-port", Number.isInteger(fixture.controlPort) && fixture.controlPort > 0);
    record("startup.spki-shape", /^[A-Za-z0-9+/]{43}=$/.test(fixture.spkiSha256 ?? ""));
    record("startup.force-quic-origin", fixture.forceQuicOrigin === `127.0.0.1:${fixture.udpPort}`);

    const stats0 = await fixture.stats();
    record(
      "control.stats-shape",
      stats0.connections === 0 &&
        stats0.requests === 0 &&
        Array.isArray(stats0.peerPorts) &&
        Array.isArray(stats0.peerAddrs),
      `connections=${stats0.connections} requests=${stats0.requests}`,
    );

    {
      // The certificate the fixture wrote must hash to the advertised pin.
      const pem = await readFile(fixture.certPath, "utf8");
      const certificate = new X509Certificate(pem);
      const spki = certificate.publicKey.export({ type: "spki", format: "der" });
      const pin = createHash("sha256").update(spki).digest("base64");
      record("cert.spki-matches-advertised-pin", pin === fixture.spkiSha256);
      record(
        "cert.loopback-san",
        (certificate.subjectAltName ?? "").includes("127.0.0.1"),
        certificate.subjectAltName,
      );
    }

    if (!fixture.tcpPort) {
      record("tcp-fallback.listener", false, "no TCP fallback port bound");
    } else {
      const ca = await readFile(fixture.certPath, "utf8");
      const response = await httpGetTls({ port: fixture.tcpPort, ca });
      const body = JSON.parse(response.body);
      record("tcp-fallback.http1", response.status === 200 && body.protocol === "http/1.1", `status=${response.status}`);
      record("tcp-fallback.path-echo", body.path === "/fixture", `path=${body.path}`);
      const stats1 = await fixture.stats();
      record("control.tcp-counter", stats1.tcpRequests === 1, `tcpRequests=${stats1.tcpRequests}`);
      record(
        "control.tcp-path-recorded",
        Boolean(stats1.paths?.["/fixture [tcp]"]),
        JSON.stringify(stats1.paths ?? {}),
      );
      record("control.no-quic-claim", stats1.connections === 0, "TCP traffic must not increment QUIC connections");
    }
  } finally {
    await fixture.close().catch(() => {});
  }
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\nh3 selfcheck: ${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exitCode = 1;
