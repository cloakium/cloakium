import net from "node:net";
import { createHash } from "node:crypto";
import { closeServer, closeSocket, listenTcp, listenTcpAt, wallNow } from "./util.mjs";

const CONTENT_TYPE_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const MAX_CLIENT_HELLO = 16_384;

const isGrease = (value) => (value & 0x0f0f) === 0x0a0a;

function hex(value, width = 4) {
  return value.toString(16).padStart(width, "0");
}

function parseExtensions(body) {
  const extensions = { types: [], sni: null, alpn: [], supportedVersions: [], groups: [], pointFormats: [] };
  const length = body.readUInt16BE(0);
  let offset = 2;
  const end = Math.min(2 + length, body.length);
  while (offset + 4 <= end) {
    const type = body.readUInt16BE(offset);
    const size = body.readUInt16BE(offset + 2);
    const data = body.subarray(offset + 4, Math.min(offset + 4 + size, end));
    extensions.types.push(type);
    if (type === 0x0000 && data.length >= 5) {
      const nameLength = data.readUInt16BE(3);
      extensions.sni = data.subarray(5, 5 + nameLength).toString("utf8");
    } else if (type === 0x0010 && data.length >= 2) {
      const listLength = data.readUInt16BE(0);
      let index = 2;
      while (index < 2 + listLength && index < data.length) {
        const entryLength = data[index];
        extensions.alpn.push(data.subarray(index + 1, index + 1 + entryLength).toString("utf8"));
        index += 1 + entryLength;
      }
    } else if (type === 0x002b && data.length >= 1) {
      const listLength = data[0];
      for (let index = 1; index + 1 < 1 + listLength && index + 1 < data.length; index += 2) {
        extensions.supportedVersions.push(data.readUInt16BE(index));
      }
    } else if (type === 0x000a && data.length >= 2) {
      const listLength = data.readUInt16BE(0);
      for (let index = 2; index + 1 < 2 + listLength && index + 1 < data.length; index += 2) {
        extensions.groups.push(data.readUInt16BE(index));
      }
    } else if (type === 0x000b && data.length >= 1) {
      const listLength = data[0];
      for (let index = 1; index < 1 + listLength && index < data.length; index += 1) {
        extensions.pointFormats.push(data[index]);
      }
    }
    offset += 4 + size;
  }
  return extensions;
}

/** Parse an assembled ClientHello handshake message. Returns null if unusable. */
export function parseClientHelloMessage(message, recordVersion) {
  if (message.length < 4 || message[0] !== HANDSHAKE_CLIENT_HELLO) return null;
  const handshakeLength = message.readUIntBE(1, 3);
  if (message.length < 4 + handshakeLength) return null;

  const body = message.subarray(4, 4 + handshakeLength);
  let offset = 0;
  const clientVersion = body.readUInt16BE(offset);
  offset += 2;
  const random = body.subarray(offset, offset + 32);
  offset += 32;
  const sessionIdLength = body[offset];
  offset += 1 + sessionIdLength;
  const cipherLength = body.readUInt16BE(offset);
  offset += 2;
  const ciphers = [];
  for (let index = 0; index < cipherLength; index += 2) {
    ciphers.push(body.readUInt16BE(offset + index));
  }
  offset += cipherLength;
  const compressionLength = body[offset];
  offset += 1 + compressionLength;
  const extensions = body.length >= offset + 2 ? parseExtensions(body.subarray(offset)) : parseExtensions(Buffer.alloc(2));

  const cipherIds = ciphers.filter((value) => !isGrease(value));
  const extensionIds = extensions.types.filter((value) => !isGrease(value));
  const groups = extensions.groups.filter((value) => !isGrease(value));
  const ja3 = [
    clientVersion,
    cipherIds.join("-"),
    extensionIds.join("-"),
    groups.join("-"),
    extensions.pointFormats.join("-"),
  ].join(",");

  return {
    recordVersion: hex(recordVersion),
    handshakeType: message[0],
    handshakeLength,
    clientVersion: hex(clientVersion),
    sessionIdLength,
    cipherCount: cipherIds.length,
    cipherSample: cipherIds.slice(0, 8).map((value) => hex(value)).join("-"),
    extensionTypes: extensionIds,
    sni: extensions.sni,
    alpn: extensions.alpn,
    supportedVersions: extensions.supportedVersions.filter((value) => !isGrease(value)).map((value) => hex(value)),
    groups,
    pointFormats: extensions.pointFormats,
    randomZeroed: random.every((byte) => byte === 0),
    ja3,
    ja3Hash: createHash("md5").update(ja3).digest("hex"),
  };
}

/** Accumulate TLS records until a complete ClientHello is available. */
export function tryParseClientHello(buffer) {
  const payloads = [];
  let offset = 0;
  let recordVersion = null;
  while (offset + 5 <= buffer.length) {
    const type = buffer[offset];
    const length = buffer.readUInt16BE(offset + 3);
    if (offset + 5 + length > buffer.length) break;
    if (recordVersion === null && type === CONTENT_TYPE_HANDSHAKE) {
      recordVersion = buffer.readUInt16BE(offset + 1);
    }
    if (type === CONTENT_TYPE_HANDSHAKE) payloads.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    if (payloads.length) {
      const combined = Buffer.concat(payloads);
      if (combined.length >= 4) {
        const handshakeLength = combined.readUIntBE(1, 3);
        if (combined.length >= 4 + handshakeLength) {
          return parseClientHelloMessage(combined.subarray(0, 4 + handshakeLength), recordVersion);
        }
      }
    }
  }
  return null;
}

/**
 * TCP listener that captures the first ClientHello and closes. No handshake,
 * no decryption, no secrets: metadata only.
 */
export async function startClientHelloTap() {
  const captures = [];
  const counters = { connections: 0, captured: 0, abandoned: 0, oversized: 0 };
  const sockets = new Set();

  const handleConnection = (socket) => {
    counters.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => closeSocket(socket));

    let chunks = [];
    let total = 0;
    let done = false;

    socket.on("data", (chunk) => {
      if (done) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_CLIENT_HELLO) {
        counters.oversized += 1;
        done = true;
        socket.destroy();
        return;
      }
      const parsed = tryParseClientHello(Buffer.concat(chunks));
      if (!parsed) return;
      done = true;
      counters.captured += 1;
      captures.push({ at: wallNow(), ...parsed });
      chunks = [];
      socket.end();
    });

    socket.on("close", () => {
      if (!done) counters.abandoned += 1;
    });
  };

  const primary = net.createServer(handleConnection);
  const port = await listenTcp(primary);

  // Also answer on IPv6 loopback so `localhost` works regardless of resolver order.
  let secondary = null;
  try {
    secondary = net.createServer(handleConnection);
    await listenTcpAt(secondary, "::1", port);
  } catch {
    try {
      secondary.close();
    } catch {
      /* not listening */
    }
    secondary = null;
  }

  return {
    host: "127.0.0.1",
    port,
    url: `https://localhost:${port}`,
    urls: { ipv4: `https://127.0.0.1:${port}`, ipv6: secondary ? `https://[::1]:${port}` : null, localhost: `https://localhost:${port}` },
    stats() {
      return { ...counters, last: captures.at(-1) ?? null, captures: captures.slice(-10) };
    },
    async close() {
      for (const socket of sockets) closeSocket(socket);
      sockets.clear();
      await Promise.all([closeServer(primary), secondary ? closeServer(secondary) : Promise.resolve()]);
    },
  };
}
