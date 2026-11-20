import dgram from "node:dgram";
import { listenUdp, wallNow } from "./util.mjs";

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;

function attribute(type, value) {
  const padding = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(padding)]);
}

function addressAttribute(type, port, address, xor) {
  const body = Buffer.alloc(8);
  body[1] = 0x01;
  const octets = address.split(".").map(Number);
  const packed = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  body.writeUInt16BE(xor ? port ^ (MAGIC >>> 16) : port, 2);
  body.writeUInt32BE(xor ? (packed ^ MAGIC) >>> 0 : packed, 4);
  return attribute(type, body);
}

/**
 * RFC 5389 binding responder on loopback. Receipt of a binding request is the
 * direct evidence that a UDP flow actually left the browser (not just that a
 * candidate string was reported).
 */
export async function startStun() {
  const socket = dgram.createSocket("udp4");
  const counters = { requests: 0, responses: 0, malformed: 0 };
  const sources = [];
  const transactions = new Set();

  socket.on("error", () => {});
  socket.on("message", (message, rinfo) => {
    if (message.length < 20 || message.readUInt16BE(0) !== BINDING_REQUEST || message.readUInt32BE(4) !== MAGIC) {
      counters.malformed += 1;
      return;
    }
    counters.requests += 1;
    const transaction = message.subarray(8, 20);
    transactions.add(transaction.toString("hex"));
    sources.push({ at: wallNow(), loopback: rinfo.address === "127.0.0.1", port: rinfo.port });

    const attributes = Buffer.concat([
      addressAttribute(0x0020, rinfo.port, rinfo.address, true),
      addressAttribute(0x0001, rinfo.port, rinfo.address, false),
      attribute(0x8022, Buffer.from("cloakium-lab-stun", "utf8")),
    ]);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(BINDING_SUCCESS, 0);
    header.writeUInt16BE(attributes.length, 2);
    header.writeUInt32BE(MAGIC, 4);
    transaction.copy(header, 8);

    socket.send(Buffer.concat([header, attributes]), rinfo.port, rinfo.address, (error) => {
      if (!error) counters.responses += 1;
    });
  });

  const port = await listenUdp(socket);

  return {
    host: "127.0.0.1",
    port,
    url: `stun:127.0.0.1:${port}`,
    stats() {
      return {
        ...counters,
        uniqueTransactions: transactions.size,
        uniqueSourcePorts: new Set(sources.map((entry) => entry.port)).size,
        sourcePorts: [...new Set(sources.map((entry) => entry.port))],
        nonLoopbackSources: sources.filter((entry) => !entry.loopback).length,
        lastRequestAt: sources.at(-1)?.at ?? null,
      };
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
