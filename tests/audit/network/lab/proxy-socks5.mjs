import dgram from "node:dgram";
import net from "node:net";
import {
  closeServer,
  closeSocket,
  listenTcp,
  listenUdp,
  normalizeHost,
  wallNow,
} from "./util.mjs";

const VER = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NONE = 0xff;
const CMD_CONNECT = 0x01;
const CMD_UDP_ASSOCIATE = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const MAX_BUFFER = 65_536;

const REP = {
  ok: 0x00,
  generalFailure: 0x01,
  notAllowed: 0x02,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressNotSupported: 0x08,
};

/** RFC 1928 / RFC 1929 SOCKS5 server with a loopback-only relay. */
export async function startSocks5({ requireAuth = false, credentials = null } = {}) {
  const counters = {
    greetings: 0,
    authOk: 0,
    authFail: 0,
    connects: 0,
    connectAttempts: 0,
    udpAssociateRequests: 0,
    udpDatagrams: 0,
    udpRelayed: 0,
    udpResponses: 0,
    udpFragmentsDropped: 0,
    blockedExternal: 0,
    rejects: 0,
    unsupportedCommands: 0,
    malformed: 0,
  };
  const offered = new Map();
  const atypCounts = { ipv4: 0, domain: 0, ipv6: 0 };
  const accepted = [];
  const ACCEPT_LIMIT = 64;
  let acceptedTotal = 0;
  let acceptedTruncated = 0;
  const noteAccepted = (record) => {
    acceptedTotal += 1;
    if (accepted.length < ACCEPT_LIMIT) accepted.push(record);
    else acceptedTruncated += 1;
  };
  const targets = [];
  const relayPorts = [];
  const RELAY_PORT_LIMIT = 64;
  const sockets = new Set();
  const associations = new Set();

  const isLoopbackTarget = (host) => {
    const normalized = normalizeHost(host).toLowerCase();
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
  };

  const reply = (socket, code, atyp, address, port) => {
    const head = Buffer.alloc(4);
    head[0] = VER;
    head[1] = code;
    head[2] = 0x00;
    head[3] = atyp;
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([head, address, portBuffer]));
  };

  const loopbackAddress = Buffer.from([127, 0, 0, 1]);

  const handleConnection = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => closeSocket(socket));

    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let association = null;

    const closeAssociation = () => {
      if (!association) return;
      try {
        association.client.close();
      } catch {
        /* already closed */
      }
      try {
        association.upstream.close();
      } catch {
        /* already closed */
      }
      associations.delete(association);
      association = null;
    };

    socket.on("close", closeAssociation);

    const onCommand = (cmd, atyp, host, port, leftover) => {
      if (cmd === CMD_CONNECT) {
        counters.connectAttempts += 1;
        const openedAt = wallNow();
        if (!isLoopbackTarget(host)) {
          counters.blockedExternal += 1;
          reply(socket, REP.notAllowed, ATYP_IPV4, loopbackAddress, 0);
          socket.end();
          return;
        }
        if (atyp === ATYP_DOMAIN) atypCounts.domain += 1;
        else if (atyp === ATYP_IPV6) atypCounts.ipv6 += 1;
        else atypCounts.ipv4 += 1;
        targets.push({ cmd: "connect", host: normalizeHost(host), port, atyp, at: wallNow() });

        const upstream = net.connect({ host: normalizeHost(host), port });
        upstream.on("error", () => {
          counters.rejects += 1;
          reply(socket, REP.connectionRefused, ATYP_IPV4, loopbackAddress, 0);
          socket.end();
        });
        upstream.on("connect", () => {
          counters.connects += 1;
          const record = {
            kind: "socks5-connect",
            targetHost: normalizeHost(host).toLowerCase(),
            targetPort: port,
            openedAt,
            connectedAt: wallNow(),
            closedAt: null,
            localPort: upstream.localPort ?? null,
            auth: requireAuth ? "accepted" : "no-auth",
            method: "CONNECT",
          };
          upstream.once("close", () => { record.closedAt = record.closedAt ?? wallNow(); });
          noteAccepted(record);
          reply(socket, REP.ok, ATYP_IPV4, loopbackAddress, 0);
          if (leftover?.length) upstream.write(leftover);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("close", () => closeSocket(socket));
        socket.on("close", () => closeSocket(upstream));
        return;
      }

      if (cmd === CMD_UDP_ASSOCIATE) {
        counters.udpAssociateRequests += 1;
        targets.push({ cmd: "udp-associate", host: normalizeHost(host), port, atyp, at: wallNow() });
        const client = dgram.createSocket("udp4");
        const upstream = dgram.createSocket("udp4");
        let lastClient = null;

        client.on("message", (message, rinfo) => {
          if (message.length < 5 || message[2] !== 0x00) {
            counters.udpFragmentsDropped += 1;
            return;
          }
          lastClient = rinfo;
          const datagramAtyp = message[3];
          let offset = 4;
          let targetHost = null;
          if (datagramAtyp === ATYP_IPV4) {
            targetHost = `${message[offset]}.${message[offset + 1]}.${message[offset + 2]}.${message[offset + 3]}`;
            offset += 4;
          } else if (datagramAtyp === ATYP_DOMAIN) {
            const length = message[offset];
            targetHost = message.subarray(offset + 1, offset + 1 + length).toString("utf8");
            offset += 1 + length;
          } else {
            counters.malformed += 1;
            return;
          }
          const targetPort = message.readUInt16BE(offset);
          offset += 2;
          if (!isLoopbackTarget(targetHost)) {
            counters.blockedExternal += 1;
            return;
          }
          const payload = message.subarray(offset);
          counters.udpDatagrams += 1;
          upstream.send(payload, targetPort, normalizeHost(targetHost), (error) => {
            if (error) counters.rejects += 1;
            else counters.udpRelayed += 1;
          });
        });

        upstream.on("message", (message, rinfo) => {
          if (!lastClient) return;
          const host = Buffer.from(rinfo.address.split(".").map(Number));
          const head = Buffer.from([0x00, 0x00, 0x00, ATYP_IPV4]);
          const portBuffer = Buffer.alloc(2);
          portBuffer.writeUInt16BE(rinfo.port, 0);
          const packet = Buffer.concat([head, host, portBuffer, message]);
          client.send(packet, lastClient.port, lastClient.address, (error) => {
            if (error) counters.rejects += 1;
            else counters.udpResponses += 1;
          });
        });

        listenUdp(client)
          .then(async () => {
            await listenUdp(upstream);
            // Attribution for UDP-bypass analysis: the upstream socket's local
            // port is the source port a target observes for relayed datagrams.
            relayPorts.push({
              clientPort: client.address().port,
              upstreamPort: upstream.address().port,
              at: wallNow(),
            });
            if (relayPorts.length > RELAY_PORT_LIMIT) relayPorts.shift();
            association = { client, upstream, host: normalizeHost(host) };
            associations.add(association);
            reply(socket, REP.ok, ATYP_IPV4, loopbackAddress, client.address().port);
          })
          .catch(() => {
            counters.malformed += 1;
            reply(socket, REP.generalFailure, ATYP_IPV4, loopbackAddress, 0);
            socket.end();
          });
        return;
      }

      counters.unsupportedCommands += 1;
      reply(socket, REP.commandNotSupported, ATYP_IPV4, loopbackAddress, 0);
      socket.end();
    };

    const drain = () => {
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2) return;
          const version = buffer[0];
          const count = buffer[1];
          if (version !== VER) {
            counters.malformed += 1;
            socket.end(Buffer.from([VER, METHOD_NONE]));
            return;
          }
          if (buffer.length < 2 + count) return;
          const list = [...buffer.subarray(2, 2 + count)];
          buffer = buffer.subarray(2 + count);
          counters.greetings += 1;
          for (const method of list) {
            offered.set(method, (offered.get(method) ?? 0) + 1);
          }
          if (requireAuth && list.includes(METHOD_USERPASS)) {
            socket.write(Buffer.from([VER, METHOD_USERPASS]));
            stage = "auth";
            continue;
          }
          if (!requireAuth && list.includes(METHOD_NO_AUTH)) {
            socket.write(Buffer.from([VER, METHOD_NO_AUTH]));
            stage = "request";
            continue;
          }
          counters.authFail += 1;
          socket.end(Buffer.from([VER, METHOD_NONE]));
          return;
        }

        if (stage === "auth") {
          if (buffer.length < 2) return;
          if (buffer[0] !== 0x01) {
            counters.malformed += 1;
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passLength = buffer[2 + userLength];
          const total = 2 + userLength + 1 + passLength;
          if (buffer.length < total) return;
          const username = buffer.subarray(2, 2 + userLength).toString("utf8");
          const password = buffer.subarray(3 + userLength, total).toString("utf8");
          buffer = buffer.subarray(total);
          const ok = Boolean(credentials) && username === credentials.username && password === credentials.password;
          if (ok) counters.authOk += 1;
          else counters.authFail += 1;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = "request";
          continue;
        }

        if (stage === "request") {
          if (buffer.length < 4) return;
          const version = buffer[0];
          const cmd = buffer[1];
          const atyp = buffer[3];
          let offset = 4;
          let host = null;
          if (version !== VER) {
            counters.malformed += 1;
            socket.end();
            return;
          }
          if (atyp === ATYP_IPV4) {
            if (buffer.length < offset + 4 + 2) return;
            host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
            offset += 4;
          } else if (atyp === ATYP_DOMAIN) {
            if (buffer.length < offset + 1) return;
            const length = buffer[offset];
            if (buffer.length < offset + 1 + length + 2) return;
            host = buffer.subarray(offset + 1, offset + 1 + length).toString("utf8");
            offset += 1 + length;
          } else if (atyp === ATYP_IPV6) {
            if (buffer.length < offset + 16 + 2) return;
            const groups = [];
            for (let index = 0; index < 8; index += 1) {
              groups.push(buffer.readUInt16BE(offset + index * 2).toString(16));
            }
            host = groups.join(":");
            offset += 16;
          } else {
            counters.malformed += 1;
            reply(socket, REP.addressNotSupported, ATYP_IPV4, loopbackAddress, 0);
            socket.end();
            return;
          }
          const port = buffer.readUInt16BE(offset);
          offset += 2;
          const leftover = buffer.subarray(offset);
          buffer = Buffer.alloc(0);
          stage = "tunnel";
          onCommand(cmd, atyp, host, port, leftover);
          return;
        }

        return;
      }
    };

    socket.on("data", (chunk) => {
      if (buffer.length + chunk.length > MAX_BUFFER) {
        counters.malformed += 1;
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
  };

  const server = net.createServer(handleConnection);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenTcp(server);

  return {
    url: `socks5://127.0.0.1:${port}`,
    port,
    requireAuth,
    credentials,
    stats() {
      return {
        ...counters,
        offeredMethods: Object.fromEntries([...offered.entries()].sort((a, b) => a[0] - b[0])),
        atypCounts: { ...atypCounts },
        accepted: accepted.slice(),
        acceptedTotal,
        acceptedTruncated,
        coverage: { complete: acceptedTruncated === 0, records: accepted.length, total: acceptedTotal, truncated: acceptedTruncated },
        targets: targets.slice(-50),
        relayPorts: relayPorts.slice(),
        upstreamPorts: relayPorts.map((entry) => entry.upstreamPort),
        openConnections: sockets.size,
        openAssociations: associations.size,
      };
    },
    async close() {
      for (const association of associations) {
        try {
          association.client.close();
        } catch {
          /* ignore */
        }
        try {
          association.upstream.close();
        } catch {
          /* ignore */
        }
      }
      associations.clear();
      for (const socket of sockets) closeSocket(socket);
      sockets.clear();
      await closeServer(server);
    },
  };
}
