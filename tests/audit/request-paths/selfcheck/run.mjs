/**
 * Offline checks for the request-path fixtures and attribution rules.
 * No browser, no caller-supplied executable, no credential value in the output.
 * These are fixture assertions, not behaviour claims: the report carries no
 * `passed: true` check objects.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startLab, requestPathEndpoints } from "../lab.mjs";
import { classifyEgress, deltaCounters } from "../probes/kit.mjs";
import { correlateAttribution } from "../probes/attribution.mjs";

const results = [];
function ok(name, detail = "") {
  results.push({ name, ok: true, detail });
}

function httpGet({ port, host = "127.0.0.1", path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("client timeout")));
    request.end();
  });
}

function proxyAbsolute({ proxyPort, path }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: proxyPort, path, headers: { host: new URL(path).host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }
    );
    request.on("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("proxy client timeout")));
    request.end();
  });
}

function proxyConnect({ proxyPort, target }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on("response", (response) => resolve({ status: response.statusCode, socket: null }));
    request.on("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("connect timeout")));
    request.end();
  });
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Minimal RFC 1928 / RFC 1929 client: CONNECT to an IPv4 target, then one HTTP GET. */
function socksGet({ port, targetHost, targetPort, credentials, path }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let stage = "method";
    let responseText = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socks client timeout"));
    }, 5_000);

    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const send = (chunks) => socket.write(Buffer.concat(chunks));

    const advance = () => {
      for (;;) {
        if (stage === "method") {
          if (buffer.length < 2) return;
          const method = buffer[1];
          buffer = buffer.subarray(2);
          if (method === 0xff) return finish(new Error("socks method refused"));
          if (method === 0x02) {
            const user = Buffer.from(credentials.username);
            const pass = Buffer.from(credentials.password);
            send([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
            stage = "auth";
            continue;
          }
          stage = "reply";
          send([Buffer.from([0x05, 0x01, 0x00, 0x01, ...targetHost.split(".").map(Number), targetPort >> 8, targetPort & 0xff])]);
          continue;
        }
        if (stage === "auth") {
          if (buffer.length < 2) return;
          const status = buffer[1];
          buffer = buffer.subarray(2);
          if (status !== 0x00) return finish(new Error("socks auth rejected"));
          stage = "reply";
          send([Buffer.from([0x05, 0x01, 0x00, 0x01, ...targetHost.split(".").map(Number), targetPort >> 8, targetPort & 0xff])]);
          continue;
        }
        if (stage === "reply") {
          if (buffer.length < 4) return;
          const code = buffer[1];
          const atyp = buffer[3];
          const length = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + buffer[4];
          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          if (code !== 0x00) return finish(new Error(`socks reply ${code}`));
          stage = "http";
          socket.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`);
          continue;
        }
        if (stage === "http") {
          responseText += buffer.toString("utf8");
          buffer = Buffer.alloc(0);
          const split = responseText.indexOf("\r\n\r\n");
          if (split < 0) return;
          const head = responseText.slice(0, split);
          const body = decodeBody(head, responseText.slice(split + 4));
          const status = Number(head.split(" ")[1]);
          if (!parseJson(body)) return;
          return finish(null, { status, body });
        }
        return;
      }
    };

    socket.on("connect", () => {
      const method = credentials ? 0x02 : 0x00;
      socket.write(Buffer.from([0x05, 0x01, method]));
    });
    socket.on("end", () => {
      if (stage === "http" && responseText) {
        const split = responseText.indexOf("\r\n\r\n");
        const head = split < 0 ? "" : responseText.slice(0, split);
        const body = split < 0 ? "" : decodeBody(head, responseText.slice(split + 4));
        if (parseJson(body)) {
          const status = Number(head.split(" ")[1]);
          return finish(null, { status, body });
        }
      }
      finish(new Error("socks response ended before a complete body"));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      advance();
    });
    socket.on("error", (error) => finish(error));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Node responses on this fixture may use chunked framing; decode before parsing. */
function decodeBody(head, body) {
  if (!/transfer-encoding:\s*chunked/i.test(head)) return body;
  let out = "";
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) return out;
    const size = Number.parseInt(body.slice(offset, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) return out;
    out += body.slice(lineEnd + 2, lineEnd + 2 + size);
    offset = lineEnd + 2 + size + 2;
  }
}

const lab = await startLab();
try {
  const originHost = new URL(lab.origin).host;
  const originPort = Number(new URL(lab.origin).port);
  const endpoints = requestPathEndpoints(lab);
  assert.equal(endpoints.length, 4);
  assert(endpoints.every((entry) => entry.available && entry.url));
  ok("lab exposes four proxy endpoints on ephemeral loopback ports");

  // 1. Direct Node request: origin hit, no proxy counter movement.
  const directBefore = lab.proxy.http.stats();
  const direct = await httpGet({ port: originPort, path: "/echo?probe=direct", headers: { host: originHost } });
  const directDelta = deltaCounters(directBefore, lab.proxy.http.stats());
  const directBody = parseJson(direct.body);
  assert.equal(direct.status, 200);
  assert.equal(directBody?.headers?.host, originHost);
  assert.equal(directDelta.absoluteRequests, 0);
  assert.equal(
    classifyEgress({ delta: directDelta, proxyUrl: lab.proxy.http.url, receipt: { body: directBody } }).mode,
    "direct",
  );
  ok("direct client reaches the origin while the proxy counter stays flat");

  // 2. Absolute-form through the anonymous HTTP proxy: counter advances, Host preserved.
  const proxiedBefore = lab.proxy.http.stats();
  const proxied = await httpGet({
    port: lab.proxy.http.port,
    path: `${lab.origin}/echo?probe=absolute`,
    headers: { host: originHost },
  });
  const proxiedDelta = deltaCounters(proxiedBefore, lab.proxy.http.stats());
  const proxiedBody = parseJson(proxied.body);
  assert.equal(proxied.status, 200);
  assert.equal(proxiedDelta.absoluteRequests, 1);
  assert.equal(proxiedBody?.headers?.host, originHost);
  assert.equal(proxiedBody?.headers?.["proxy-authorization"], undefined);
  assert.equal(
    classifyEgress({ delta: proxiedDelta, proxyUrl: lab.proxy.http.url, receipt: { body: proxiedBody } }).mode,
    "proxied",
  );
  ok("absolute-form proxy request advances the counter and preserves Host");

  // 3. Auth proxy: exact dummy credentials accepted, values never recorded.
  const auth = lab.proxy.httpAuth.credentials;
  const authBefore = lab.proxy.httpAuth.stats();
  const accepted = await httpGet({
    port: lab.proxy.httpAuth.port,
    path: `${lab.origin}/echo?probe=auth`,
    headers: { host: originHost, "proxy-authorization": basic(auth.username, auth.password) },
  });
  const authDelta = deltaCounters(authBefore, lab.proxy.httpAuth.stats());
  const acceptedBody = parseJson(accepted.body);
  assert.equal(accepted.status, 200);
  assert.equal(authDelta.authOk, 1);
  assert.equal(acceptedBody?.headers?.["proxy-authorization"], undefined);
  ok("authenticated proxy accepts the dummy fixture credentials");

  // 4. Auth proxy without credentials: 407 and a recorded rejection.
  const rejectBefore = lab.proxy.httpAuth.stats();
  const refused = await httpGet({
    port: lab.proxy.httpAuth.port,
    path: `${lab.origin}/echo?probe=no-auth`,
    headers: { host: originHost },
  });
  const rejectDelta = deltaCounters(rejectBefore, lab.proxy.httpAuth.stats());
  assert.equal(refused.status, 407);
  assert.equal(rejectDelta.rejectedAuth, 1);
  ok("auth-required proxy refuses an unauthenticated request");

  // 5. SOCKS5 CONNECT (no auth) then SOCKS5 with RFC 1929 credentials.
  const socksBefore = lab.proxy.socks5.stats();
  const socks = await socksGet({
    port: lab.proxy.socks5.port,
    targetHost: "127.0.0.1",
    targetPort: originPort,
    path: "/echo?probe=socks5",
  });
  const socksDelta = deltaCounters(socksBefore, lab.proxy.socks5.stats());
  assert.equal(socks.status, 200);
  assert.equal(socksDelta.connects, 1);
  assert.equal(parseJson(socks.body)?.headers?.host, originHost);
  ok("SOCKS5 CONNECT advances connects and preserves Host");

  const socksAuthCreds = lab.proxy.socks5Auth.credentials;
  const socksAuthBefore = lab.proxy.socks5Auth.stats();
  const socksAuth = await socksGet({
    port: lab.proxy.socks5Auth.port,
    targetHost: "127.0.0.1",
    targetPort: originPort,
    credentials: socksAuthCreds,
    path: "/echo?probe=socks5-auth",
  });
  const socksAuthDelta = deltaCounters(socksAuthBefore, lab.proxy.socks5Auth.stats());
  assert.equal(socksAuth.status, 200);
  assert.equal(socksAuthDelta.authOk, 1);
  assert.equal(socksAuthDelta.connects, 1);
  ok("SOCKS5 RFC 1929 dummy credentials are accepted");

  // 6. Classification and counter mapping.
  const cases = [
    [{ delta: { absoluteRequests: 2 }, proxyUrl: "http://127.0.0.1:1", receipt: { body: {} } }, "proxied"],
    [{ delta: { absoluteRequests: 0 }, proxyUrl: "http://127.0.0.1:1", receipt: { body: {} } }, "direct"],
    [{ delta: { connects: 1 }, proxyUrl: "http://127.0.0.1:1", receipt: { body: {} } }, "proxied"],
    [{ delta: { connects: 1 }, proxyUrl: "socks5://127.0.0.1:1", receipt: { body: {} } }, "proxied"],
    [{ delta: { connects: 0 }, proxyUrl: "socks5://127.0.0.1:1", receipt: { body: {} } }, "direct"],
    [{ delta: { connects: 1 }, proxyUrl: "socks5://127.0.0.1:1", receipt: null }, "unknown"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyEgress(input).mode, expected, JSON.stringify(input));
  }
  assert.deepEqual(deltaCounters({ a: 1, b: "x" }, { a: 4, b: "y", c: 9 }), { a: 3 });
  ok("egress classification maps counters to proxied/direct/unknown");

  // 7. Request-level attribution: accepted destination/connection evidence.
  const correlationLab = await startLab();
  try {
    const originHost2 = new URL(correlationLab.origin).host;
    const originPort2 = Number(new URL(correlationLab.origin).port);
    const attribution = (body, witness) => classifyEgress({
      delta: {},
      proxyUrl: correlationLab.proxy.http.url,
      receipt: { body },
      witness
    });
    const directEcho = async (label) => {
      const response = await httpGet({ port: originPort2, path: `/echo?probe=correlation-${label}`, headers: { host: originHost2 } });
      assert.equal(response.status, 200);
      return parseJson(response.body);
    };

    // Direct receipt first, with a complete but empty witness.
    const directBody = await directEcho("direct");
    const directEgress = attribution(directBody, correlationLab.proxy.http.stats());
    assert.equal(directEgress.mode, "direct");
    assert.equal(directEgress.scope, "request-connection");
    assert.equal(directEgress.method, "origin-peer-not-proxied");
    assert.equal(directEgress.correlation.records, 0);
    ok("direct origin receipt with complete witness is direct");

    // Unrelated REJECTED proxy traffic must not change the attribution.
    const blocked = await proxyAbsolute({ proxyPort: correlationLab.proxy.http.port, path: "http://example.invalid/" });
    assert.equal(blocked.status, 403);
    const afterBlocked = attribution(await directEcho("after-blocked"), correlationLab.proxy.http.stats());
    assert.equal(afterBlocked.mode, "direct");
    ok("unrelated rejected proxy traffic does not prove egress");

    const blockedConnect = await proxyConnect({ proxyPort: correlationLab.proxy.http.port, target: "example.invalid:443" });
    assert.equal(blockedConnect.status, 403);
    blockedConnect.socket?.destroy();
    const afterBlockedConnect = attribution(await directEcho("after-blocked-connect"), correlationLab.proxy.http.stats());
    assert.equal(afterBlockedConnect.mode, "direct");
    ok("unrelated rejected CONNECT does not prove egress");

    // Unrelated ACCEPTED connection to a different destination.
    const other = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ other: true }));
    });
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = other.address().port;
    try {
      const otherResponse = await proxyAbsolute({ proxyPort: correlationLab.proxy.http.port, path: `http://127.0.0.1:${otherPort}/` });
      assert.equal(otherResponse.status, 200);
      const afterOther = attribution(await directEcho("after-other"), correlationLab.proxy.http.stats());
      assert.equal(afterOther.mode, "direct", JSON.stringify(afterOther));
      ok("unrelated accepted connection to another destination does not prove egress");
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }

    // Accepted absolute-form request to the expected origin correlates by peer port.
    const absolute = await proxyAbsolute({ proxyPort: correlationLab.proxy.http.port, path: `${correlationLab.origin}/echo?probe=correlation-absolute` });
    const absoluteBody = parseJson(absolute.body);
    const absoluteEgress = attribution(absoluteBody, correlationLab.proxy.http.stats());
    assert.equal(absoluteEgress.mode, "proxied", JSON.stringify(absoluteEgress));
    assert.equal(absoluteEgress.method, "absolute-peer-port-target-path");
    assert.equal(absoluteEgress.correlation.matched.kind, "absolute");
    assert.equal(absoluteEgress.correlation.matched.auth, "not-required");
    assert.ok(!JSON.stringify(correlationLab.proxy.http.stats()).includes(auth.password));
    ok("accepted absolute-form request correlates proxied via peer port and path");

    // Accepted CONNECT tunnel to the expected origin correlates by peer port.
    const tunnel = await proxyConnect({ proxyPort: correlationLab.proxy.http.port, target: `127.0.0.1:${originPort2}` });
    assert.equal(tunnel.status, 200);
    const tunnelBody = await new Promise((resolve, reject) => {
      let text = "";
      tunnel.socket.setEncoding("utf8");
      tunnel.socket.on("data", (chunk) => {
        text += chunk;
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return;
        const body = decodeBody(text.slice(0, split), text.slice(split + 4));
        const parsed = parseJson(body);
        if (parsed) resolve(parsed);
      });
      tunnel.socket.on("error", reject);
      tunnel.socket.write(`GET /echo?probe=correlation-connect HTTP/1.1\r\nHost: ${originHost2}\r\nConnection: close\r\n\r\n`);
    });
    tunnel.socket.destroy();
    const connectEgress = attribution(tunnelBody, correlationLab.proxy.http.stats());
    assert.equal(connectEgress.mode, "proxied", JSON.stringify(connectEgress));
    assert.equal(connectEgress.method, "connect-peer-port-target");
    assert.equal(connectEgress.correlation.matched.kind, "connect");
    ok("accepted CONNECT tunnel correlates proxied via peer port");

    // Accepted SOCKS5 CONNECT correlates by the relay upstream port.
    const socksBody = await socksGet({ port: correlationLab.proxy.socks5.port, targetHost: "127.0.0.1", targetPort: originPort2, path: "/echo?probe=correlation-socks" });
    const socksEgress = classifyEgress({
      delta: {}, proxyUrl: correlationLab.proxy.socks5.url, receipt: { body: parseJson(socksBody.body) }, witness: correlationLab.proxy.socks5.stats()
    });
    assert.equal(socksEgress.mode, "proxied", JSON.stringify(socksEgress));
    assert.equal(socksEgress.method, "socks5-connect-peer-port-target");
    assert.equal(socksEgress.correlation.matched.kind, "socks5-connect");
    ok("accepted SOCKS5 connection correlates proxied via relay upstream port");

    // Expired, ambiguous and truncated witnesses are unknown, never direct/proxied guesses.
    const sample = { host: originHost2, peerPort: 50000, receivedAt: 1_000_000, path: "/echo", search: "" };
    const expired = correlateAttribution({
      body: sample,
      witness: { accepted: [{ kind: "connect", targetHost: "127.0.0.1", targetPort: originPort2, localPort: 50000, connectedAt: 900_000, closedAt: 990_000, auth: "accepted" }], coverage: { complete: true, records: 1, total: 1, truncated: 0 } }
    });
    assert.equal(expired.mode, "unknown");
    assert.equal(expired.method, "connection-window-expired");
    const ambiguous = correlateAttribution({
      body: sample,
      witness: { accepted: [{ kind: "connect", targetHost: "127.0.0.1", targetPort: originPort2 + 1, localPort: 50000, connectedAt: 999_000, closedAt: null, auth: "accepted" }], coverage: { complete: true, records: 1, total: 1, truncated: 0 } }
    });
    assert.equal(ambiguous.mode, "unknown");
    assert.equal(ambiguous.method, "peer-port-ambiguous-target");
    const truncated = correlateAttribution({
      body: sample,
      witness: { accepted: [], coverage: { complete: false, records: 0, total: 70, truncated: 6 } }
    });
    assert.equal(truncated.mode, "unknown");
    assert.equal(truncated.method, "witness-coverage-incomplete");
    ok("expired, ambiguous and truncated correlation is unknown");

    // Reused accepted tunnel: no new counter events, still open at receipt time.
    const reused = correlateAttribution({
      body: sample,
      witness: { accepted: [{ kind: "connect", targetHost: "127.0.0.1", targetPort: originPort2, localPort: 50000, connectedAt: 900_000, closedAt: null, auth: "accepted" }], coverage: { complete: true, records: 1, total: 1, truncated: 0 } }
    });
    assert.equal(reused.mode, "proxied");
    ok("a reused accepted tunnel remains proxied with a valid open witness");
  } finally {
    await correlationLab.close();
  }

  // 8. No credential value may appear in the self-check report.
  const report = {
    ok: results.length,
    checks: [],
    results,
    endpoints: endpoints.map(({ endpoint, available, requireAuth }) => ({ endpoint, available, requireAuth })),
  };
  assert.equal(report.checks.length, 0);
  const serialized = JSON.stringify(report);
  assert(!serialized.includes(auth.password));
  assert(!serialized.includes(auth.username));
  assert(!serialized.includes(socksAuthCreds.password));
  ok("self-check output carries no credential value and no passed:true checks");

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: results.length, failed: error.message, results }, null, 2));
  process.exitCode = 1;
} finally {
  await lab.close();
}
