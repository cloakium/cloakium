/** Build a synthetic TLS 1.3-offering ClientHello for tap self-tests. */

function extension(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

function vector16(items) {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(items.length, 0);
  return Buffer.concat([head, ...items]);
}

function sni(name) {
  const entry = Buffer.alloc(3);
  entry[0] = 0x00;
  entry.writeUInt16BE(name.length, 1);
  return extension(0x0000, vector16([entry, Buffer.from(name, "utf8")]));
}

function alpn(protocols) {
  const entries = protocols.map((protocol) => {
    const length = Buffer.from([protocol.length]);
    return Buffer.concat([length, Buffer.from(protocol, "utf8")]);
  });
  return extension(0x0010, vector16(entries));
}

function supportedVersions(versions) {
  const body = Buffer.alloc(1 + versions.length * 2);
  body[0] = versions.length * 2;
  versions.forEach((version, index) => body.writeUInt16BE(version, 1 + index * 2));
  return extension(0x002b, body);
}

function supportedGroups(groups) {
  const items = groups.map((group) => {
    const entry = Buffer.alloc(2);
    entry.writeUInt16BE(group, 0);
    return entry;
  });
  return extension(0x000a, vector16(items));
}

export function buildClientHello({ serverName = "lab.tap.test", protocols = ["h2", "http/1.1"] } = {}) {
  const random = Buffer.alloc(32, 0x5a);
  const ciphers = [0x1301, 0x1302, 0x1303];
  const cipherLength = Buffer.alloc(2);
  cipherLength.writeUInt16BE(ciphers.length * 2, 0);
  const cipherBuffer = Buffer.concat(
    ciphers.map((cipher) => {
      const entry = Buffer.alloc(2);
      entry.writeUInt16BE(cipher, 0);
      return entry;
    }),
  );

  const extensions = Buffer.concat([
    sni(serverName),
    supportedGroups([0x001d]),
    extension(0x000b, Buffer.from([0x01, 0x00])),
    alpn(protocols),
    supportedVersions([0x0304, 0x0303]),
    extension(0x000d, Buffer.from([0x00, 0x04, 0x04, 0x03, 0x08, 0x04])),
  ]);

  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    random,
    Buffer.from([0x00]),
    cipherLength,
    cipherBuffer,
    Buffer.from([0x01, 0x00]),
    Buffer.from([extensions.length >> 8, extensions.length & 0xff]),
    extensions,
  ]);

  const handshakeHead = Buffer.alloc(4);
  handshakeHead[0] = 0x01;
  handshakeHead.writeUIntBE(body.length, 1, 3);

  const handshake = Buffer.concat([handshakeHead, body]);
  const recordHead = Buffer.alloc(5);
  recordHead[0] = 0x16;
  recordHead.writeUInt16BE(0x0301, 1);
  recordHead.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([recordHead, handshake]);
}
