/** Minimal RFC 1035 wire helpers shared by the UDP recorder and the DoH listener. */

export function readName(buffer, offset) {
  const labels = [];
  let index = offset;
  while (index < buffer.length) {
    const length = buffer[index];
    if (length === 0) return { name: labels.join("."), offset: index + 1 };
    if ((length & 0xc0) !== 0) return { name: labels.join("."), offset: index + 2 };
    labels.push(buffer.subarray(index + 1, index + 1 + length).toString("utf8"));
    index += 1 + length;
  }
  return { name: labels.join("."), offset: index };
}

/** Returns null for anything that is not a single-question query. */
export function parseQuery(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.readUInt16BE(4) < 1) return null;
  const identifier = buffer.readUInt16BE(0);
  const question = readName(buffer, 12);
  if (question.offset + 4 > buffer.length) return null;
  return {
    id: identifier,
    name: question.name,
    type: buffer.readUInt16BE(question.offset),
    qclass: buffer.readUInt16BE(question.offset + 2),
    questionEnd: question.offset + 4,
  };
}

/** Build a response for a parsed query, answering A records inside `zone`. */
export function buildResponse(buffer, query, { zone = "lab.test", answer = "127.0.0.1", ttl = 30 } = {}) {
  const inZone = query.name === zone || query.name.endsWith(`.${zone}`);
  const isA = query.type === 1 && query.qclass === 1;
  const ok = inZone && isA;

  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(ok ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(ok ? 1 : 0, 6);
  const question = Buffer.from(buffer.subarray(12, query.questionEnd));

  if (!ok) return { response: Buffer.concat([header, question]), answered: false };

  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c, 0);
  rr.writeUInt16BE(1, 2);
  rr.writeUInt16BE(1, 4);
  rr.writeUInt32BE(ttl, 6);
  rr.writeUInt16BE(4, 10);
  const address = Buffer.from(answer.split(".").map(Number));
  return { response: Buffer.concat([header, question, rr, address]), answered: true };
}
