import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import { buildClientHello } from "./clienthello.mjs";
import { startLab } from "../lab/index.mjs";
import { withDeadline, wallNow } from "../lab/util.mjs";
import { checkDoh, checkTransparentProxy } from "./controls.mjs";

const MAGIC = 0x2112a442;
const RUN_TIMEOUT_MS = 120_000;

class Reader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length && this.buffer.length >= this.waiters[0].size) {
      const waiter = this.waiters.shift();
      const value = this.buffer.subarray(0, waiter.size);
      this.buffer = this.buffer.subarray(waiter.size);
      waiter.resolve(value);
    }
  }

  read(size, timeoutMs = 3_000) {
    if (this.buffer.length >= size) {
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      return Promise.resolve(value);
    }
    return withDeadline(
      new Promise((resolve) => this.waiters.push({ size, resolve })),
      timeoutMs,
      "socket read",
    );
  }
}

function connectTcp(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function startEcho() {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function proxyAbsolute({ proxyPort, path, headers = {}, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: proxyPort, path, method, headers: { host: new URL(path).host, ...headers } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function proxyConnect({ proxyPort, target, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target, headers });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on("response", (response) => resolve({ status: response.statusCode, socket: null }));
    request.on("error", reject);
    request.end();
  });
}

async function socksConnect({ port, target, targetPort, methods = [0x00], auth = null }) {
  const socket = await connectTcp(port);
  const reader = new Reader(socket);
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const choice = await reader.read(2);
  if (choice[1] === 0xff) return { socket, method: choice[1] };
  if (choice[1] === 0x02) {
    const user = Buffer.from(auth.username, "utf8");
    const pass = Buffer.from(auth.password, "utf8");
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const status = await reader.read(2);
    if (status[1] !== 0x00) return { socket, method: choice[1], authStatus: status[1] };
  }
  const hostBuffer = Buffer.from(target, "utf8");
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]),
      hostBuffer,
      Buffer.from([targetPort >> 8, targetPort & 0xff]),
    ]),
  );
  const reply = await reader.read(10);
  return { socket, method: choice[1], reply: reply[1], boundPort: reply.readUInt16BE(8) };
}

async function socksUdpAssociate({ port }) {
  const socket = await connectTcp(port);
  const reader = new Reader(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  await reader.read(2);
  const hostBuffer = Buffer.from([127, 0, 0, 1]);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x03, 0x00, 0x01]), hostBuffer, Buffer.from([0x00, 0x00])]));
  const reply = await reader.read(10);
  return { socket, relayPort: reply.readUInt16BE(8), target: `${reply[4]}.${reply[5]}.${reply[6]}.${reply[7]}` };
}

function stunRequest() {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(MAGIC, 4);
  for (let index = 8; index < 20; index += 1) request[index] = index;
  return request;
}

function decodeXorMapped(response, cookie = MAGIC) {
  let offset = 20;
  while (offset + 4 <= response.length) {
    const type = response.readUInt16BE(offset);
    const length = response.readUInt16BE(offset + 2);
    if (type === 0x0020) {
      const port = response.readUInt16BE(offset + 6) ^ (cookie >>> 16);
      const address = response.readUInt32BE(offset + 8) ^ cookie;
      return { port, address: [24, 16, 8, 0].map((shift) => (address >>> shift) & 0xff).join(".") };
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

function dnsQuery(name) {
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "utf8")]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.from([0x00, 0x01, 0x00, 0x01]);
  return Buffer.concat([header, ...labels, Buffer.from([0x00]), tail]);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}\n`);
}

async function main() {
  const started = wallNow();
  const lab = await startLab({ tls: true, http2: true });
  const echo = await startEcho();
  try {
    const echoProbe = async (socket) => {
      const reader = new Reader(socket);
      socket.write("ping-lab");
      const value = await reader.read(8);
      return value.toString("utf8");
    };

    const originEcho = await fetch(`${lab.origin}/echo`);
    const originBody = await originEcho.json();
    record("origin.echo", originEcho.status === 200 && originBody.headerNames.includes("host"), `status=${originEcho.status}`);

    const first = await (await fetch(`${lab.origin}/hit/selfcheck?mode=fresh`)).json();
    const second = await (await fetch(`${lab.origin}/hit/selfcheck?mode=fresh`)).json();
    record("origin.hit-counter", first.count === 1 && second.count === 2, `counts=${first.count},${second.count}`);

    const etag1 = await fetch(`${lab.origin}/hit/etag-probe?mode=etag`);
    const etag2 = await fetch(`${lab.origin}/hit/etag-probe?mode=etag`, { headers: { "if-none-match": '"lab-etag-probe"' } });
    record("origin.etag-304", etag1.status === 200 && etag2.status === 304, `statuses=${etag1.status},${etag2.status}`);

    const viaResponse = await proxyAbsolute({ proxyPort: lab.proxy.http.port, path: `${lab.origin}/echo` });
    const viaBody = JSON.parse(viaResponse.body);
    record(
      "proxy.absolute-form",
      viaResponse.status === 200 && viaBody.headers.via === "1.1 cloakium-lab",
      `status=${viaResponse.status} via=${viaBody.headers.via}`,
    );

    const noAuth = await proxyConnect({ proxyPort: lab.proxy.httpAuth.port, target: `127.0.0.1:${echo.port}` });
    record(
      "proxy.connect-407",
      noAuth.status === 407,
      `status=${noAuth.status}`,
    );
    noAuth.socket?.destroy();

    const { username, password } = lab.proxy.httpAuth.credentials;
    const authorized = await proxyConnect({
      proxyPort: lab.proxy.httpAuth.port,
      target: `127.0.0.1:${echo.port}`,
      headers: { "proxy-authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    });
    const tunnelEcho = authorized.socket ? await echoProbe(authorized.socket) : null;
    authorized.socket?.destroy();
    record("proxy.connect-auth-tunnel", authorized.status === 200 && tunnelEcho === "ping-lab", `status=${authorized.status} echo=${tunnelEcho}`);

    const blocked = await proxyAbsolute({ proxyPort: lab.proxy.http.port, path: "http://example.com/" });
    record("proxy.blocked-external", blocked.status === 403, `status=${blocked.status}`);

    const socks = await socksConnect({ port: lab.proxy.socks5.port, target: "localhost", targetPort: echo.port });
    const socksEcho = socks.reply === 0 ? await echoProbe(socks.socket) : null;
    socks.socket.destroy();
    record("socks5.connect", socks.reply === 0 && socksEcho === "ping-lab", `reply=${socks.reply} echo=${socksEcho}`);

    const socksNoMethod = await socksConnect({ port: lab.proxy.socks5Auth.port, target: "localhost", targetPort: echo.port, methods: [0x00] });
    socksNoMethod.socket.destroy();
    record("socks5.auth-required-rejects-noauth", socksNoMethod.method === 0xff, `method=${socksNoMethod.method}`);

    const socksCreds = lab.proxy.socks5Auth.credentials;
    const socksAuth = await socksConnect({
      port: lab.proxy.socks5Auth.port,
      target: "localhost",
      targetPort: echo.port,
      methods: [0x00, 0x02],
      auth: socksCreds,
    });
    const socksAuthEcho = socksAuth.reply === 0 ? await echoProbe(socksAuth.socket) : null;
    socksAuth.socket.destroy();
    record("socks5.userpass", socksAuth.method === 0x02 && socksAuth.reply === 0 && socksAuthEcho === "ping-lab", `method=${socksAuth.method} reply=${socksAuth.reply}`);

    const socksBlocked = await socksConnect({ port: lab.proxy.socks5.port, target: "example.com", targetPort: 80 });
    socksBlocked.socket.destroy();
    record("socks5.blocked-external", socksBlocked.reply === 0x02, `reply=${socksBlocked.reply}`);

    const udpEcho = dgram.createSocket("udp4");
    await new Promise((resolve) => udpEcho.bind(0, "127.0.0.1", resolve));
    let echoSourcePort = null;
    udpEcho.on("message", (message, rinfo) => {
      echoSourcePort = rinfo.port;
      udpEcho.send(message, rinfo.port, rinfo.address);
    });
    const association = await socksUdpAssociate({ port: lab.proxy.socks5.port });
    const client = dgram.createSocket("udp4");
    await new Promise((resolve) => client.bind(0, "127.0.0.1", resolve));
    const udpReply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("udp relay timeout")), 3_000);
      client.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    const payload = Buffer.from("udp-lab");
    const header = Buffer.from([0x00, 0x00, 0x00, 0x01, 127, 0, 0, 1, udpEcho.address().port >> 8, udpEcho.address().port & 0xff]);
    client.send(Buffer.concat([header, payload]), association.relayPort, "127.0.0.1");
    const relayed = await udpReply;
    const socksStats = lab.proxy.socks5.stats();
    client.close();
    udpEcho.close();
    association.socket.destroy();
    record("socks5.udp-associate-relay", relayed.subarray(10).toString("utf8") === "udp-lab", `bytes=${relayed.length}`);
    record(
      "socks5.udp-relay-attribution",
      socksStats.upstreamPorts.includes(echoSourcePort) && socksStats.udpRelayed >= 1,
      `echoSource=${echoSourcePort} upstreamPorts=${socksStats.upstreamPorts.join(",")} relayed=${socksStats.udpRelayed}`,
    );

    const stunClient = dgram.createSocket("udp4");
    await new Promise((resolve) => stunClient.bind(0, "127.0.0.1", resolve));
    const stunClientPort = stunClient.address().port;
    const stunReply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stun timeout")), 3_000);
      stunClient.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    stunClient.send(stunRequest(), lab.stun.port, "127.0.0.1");
    const stunResponse = await stunReply;
    const mapped = decodeXorMapped(stunResponse);
    stunClient.close();
    record(
      "stun.xor-mapped-address",
      stunResponse.readUInt16BE(0) === 0x0101 && mapped?.port === stunClientPort,
      `mapped=${mapped?.address}:${mapped?.port} source=${stunClientPort}`,
    );

    const dnsClient = dgram.createSocket("udp4");
    await new Promise((resolve) => dnsClient.bind(0, "127.0.0.1", resolve));
    const dnsReply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dns timeout")), 3_000);
      dnsClient.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    dnsClient.send(dnsQuery("probe.lab.test"), lab.dns.port, "127.0.0.1");
    const dnsResponse = await dnsReply;
    dnsClient.close();
    record(
      "dns.a-record",
      dnsResponse.readUInt16BE(6) === 1 && dnsResponse.subarray(-4).join(".") === "127.0.0.1",
      `answers=${dnsResponse.readUInt16BE(6)}`,
    );

    await checkDoh({ lab, record, dnsQuery });
    await checkTransparentProxy({ lab, record });

    const tapSocket = await connectTcp(lab.tap.port);
    tapSocket.write(buildClientHello());
    await withDeadline(new Promise((resolve) => tapSocket.once("close", resolve)), 3_000, "tap close");
    const tapStats = lab.tap.stats();
    record(
      "tap.clienthello",
      tapStats.captured === 1 && tapStats.last?.sni === "lab.tap.test" && tapStats.last?.alpn.includes("h2"),
      `sni=${tapStats.last?.sni} alpn=${tapStats.last?.alpn?.join(",")}`,
    );
    record("tap.ja3-shape", /^[0-9a-f]{32}$/.test(tapStats.last?.ja3Hash ?? ""), `hash=${tapStats.last?.ja3Hash}`);
    record(
      "tap.tls13-offered",
      tapStats.last?.supportedVersions.includes("0304") && tapStats.last?.recordVersion === "0301",
      `versions=${tapStats.last?.supportedVersions?.join(",")} record=${tapStats.last?.recordVersion}`,
    );

    if (lab.tls.available) {
      record("tls.material-generated", Boolean(lab.tls.caFile), `ca=${lab.tls.caFile}`);
    } else {
      record("tls.material-generated", false, lab.tls.reason ?? "unavailable");
    }

    if (lab.http2.available) {
      const http2Module = await import("node:http2");
      const ca = await import("node:fs/promises").then((module) => module.readFile(lab.tls.caFile));
      const result = await withDeadline(
        new Promise((resolve, reject) => {
          const client = http2Module.connect(lab.http2.url, { ca });
          let alpn = null;
          let data = "";
          client.on("error", reject);
          client.on("connect", () => {
            alpn = client.alpnProtocol;
          });
          const stream = client.request({ ":path": "/" });
          stream.setEncoding("utf8");
          stream.on("data", (chunk) => {
            data += chunk;
          });
          stream.on("end", () => {
            client.close();
            resolve({ alpn, body: data });
          });
          stream.on("error", reject);
          stream.end();
        }),
        5_000,
        "http2 selfcheck",
      );
      const parsed = JSON.parse(result.body);
      record("http2.alpn-h2", result.alpn === "h2" && parsed.protocol === "h2", `alpn=${result.alpn} protocol=${parsed.protocol}`);
    } else {
      record("http2.alpn-h2", false, lab.http2.reason ?? "unavailable");
    }
  } finally {
    await echo.close();
    await lab.close();
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nselfcheck: ${results.length - failed.length}/${results.length} passed in ${wallNow() - started}ms\n`);
  if (failed.length) process.exitCode = 1;
}

await withDeadline(main(), RUN_TIMEOUT_MS, "selfcheck run");
