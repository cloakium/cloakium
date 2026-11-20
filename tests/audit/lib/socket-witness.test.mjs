// Tests for the passive socket witness: synthetic table fixtures, identity
// guards, and one real localhost fixture created by this process itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

import {
  SOCKET_WITNESS_SCHEMA,
  SOCKET_WITNESS_SUPPORTED,
  formatIPv6,
  parseHexAddress,
  parseHexPort,
  parseProcNetTable,
  readProcessStartTicks,
  startSocketWitness,
  tcpStateName,
} from './socket-witness.mjs';

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

const TCP_TABLE = [
  HEADER,
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0',
  '   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 100 0 0 10 0',
  '   2: 00000000:0000 00000000:0000 06 00000000:00000000 00:00000000 00000000  1000        0 0 1 0 100 0 0 10 0',
].join('\n');

const TCP6_TABLE = [
  HEADER,
  '   0: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 100 0 0 10 0',
  '   1: 0000000000000000FFFF00000100007F:C350 0000000000000000FFFF00000100007F:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0 10 0',
].join('\n');

const UDP_TABLE = [
  HEADER,
  '   0: 0100007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 555 1 0 100 0 0 10 0',
].join('\n');

test('ipv4 addresses and ports use network byte order', () => {
  assert.equal(parseHexAddress('0100007F', 'ipv4'), '127.0.0.1');
  assert.equal(parseHexAddress('00000000', 'ipv4'), '0.0.0.0');
  assert.equal(parseHexAddress('0000A8C0', 'ipv4'), '192.168.0.0');
  assert.equal(parseHexPort('1F90'), 8080);
  assert.equal(parseHexPort('0050'), 80);
  assert.equal(parseHexPort('0000'), 0);
  assert.equal(parseHexPort('zzzz'), null);
  assert.equal(parseHexAddress('00', 'ipv4'), null);
  assert.equal(parseHexAddress('0100007F', 'nope'), null);
});

test('ipv6 loopback, unspecified and mapped forms', () => {
  assert.equal(parseHexAddress('00000000000000000000000001000000', 'ipv6'), '::1');
  assert.equal(parseHexAddress('00000000000000000000000000000000', 'ipv6'), '::');
  assert.equal(
    parseHexAddress('0000000000000000FFFF00000100007F', 'ipv6'),
    '::ffff:127.0.0.1',
  );
  assert.equal(formatIPv6(new Uint8Array(16)), '::');
  const loopback = new Uint8Array(16);
  loopback[15] = 1;
  assert.equal(formatIPv6(loopback), '::1');
  assert.equal(parseHexAddress('0100007F', 'ipv6'), null);
});

test('tcp states map to names and unknown codes stay explicit', () => {
  assert.equal(tcpStateName('0A'), 'LISTEN');
  assert.equal(tcpStateName('01'), 'ESTABLISHED');
  assert.equal(tcpStateName('06'), 'TIME_WAIT');
  assert.equal(tcpStateName('07'), 'CLOSE');
  assert.equal(tcpStateName('FF'), 'UNKNOWN(FF)');
  assert.equal(tcpStateName(undefined), 'UNKNOWN');
});

test('parses a tcp table and keeps only inode-bearing rows', () => {
  const { rows, errors } = parseProcNetTable(TCP_TABLE, { protocol: 'tcp', family: 'ipv4' });
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2, 'the inode-0 row is skipped, not reported');
  assert.deepEqual(
    { inode: rows[0].inode, addr: rows[0].localAddress, port: rows[0].localPort, state: rows[0].state },
    { inode: 111, addr: '127.0.0.1', port: 8080, state: 'LISTEN' },
  );
  assert.equal(rows[1].remoteAddress, '127.0.0.1');
  assert.equal(rows[1].remotePort, 8080);
  assert.equal(rows[1].state, 'ESTABLISHED');
});

test('parses ipv6 tables including the mapped form', () => {
  const { rows, errors } = parseProcNetTable(TCP6_TABLE, { protocol: 'tcp', family: 'ipv6' });
  assert.equal(errors.length, 0);
  assert.equal(rows[0].localAddress, '::1');
  assert.equal(rows[0].localPort, 80);
  assert.equal(rows[1].localAddress, '::ffff:127.0.0.1');
  assert.equal(rows[1].remoteAddress, '::ffff:127.0.0.1');
  assert.equal(rows[1].localPort, 50000);
  assert.equal(rows[1].remotePort, 443);
  assert.equal(rows[1].mayCarryHostname, true);
});

test('parses a udp table', () => {
  const { rows } = parseProcNetTable(UDP_TABLE, { protocol: 'udp', family: 'ipv4' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].protocol, 'udp');
  assert.equal(rows[0].localPort, 53);
  assert.equal(rows[0].state, 'CLOSE');
});

test('malformed rows are reported, never dropped quietly', () => {
  const text = [
    HEADER,
    '   0: 0100007F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0',
    '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 zz 1 0 100 0 0 10 0',
  ].join('\n');
  const { rows, errors } = parseProcNetTable(text, { protocol: 'tcp', family: 'ipv4' });
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((e) => e.code).sort(),
    ['malformed-address', 'malformed-inode'],
  );
  for (const error of errors) assert.equal(error.line > 0, true);
});

function trackerFor(pid, startTicks) {
  return {
    async sample() {
      return { processes: [{ pid, startTicks }], limitations: ['test tracker'] };
    },
  };
}

test('attributes this process own TCP listener and UDP socket', { skip: !SOCKET_WITNESS_SUPPORTED }, async () => {
  const ticks = await readProcessStartTicks(process.pid);
  assert.equal(Number.isInteger(ticks), true, 'own start ticks readable');

  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tcpPort = server.address().port;

  const udp = dgram.createSocket('udp4');
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const udpPort = udp.address().port;

  const witness = startSocketWitness({ tracker: trackerFor(process.pid, ticks), intervalMs: 60_000 });
  try {
    await witness.sample();
    await witness.sample();
    const report = await witness.close();

    assert.equal(report.schema, SOCKET_WITNESS_SCHEMA);
    assert.equal(report.coverage, 'sampled-owned-socket-metadata');
    assert.equal(report.absenceEstablished, false);
    assert.equal(Array.isArray(report.limitations) && report.limitations.length > 0, true);
    assert.equal(report.samples >= 2, true);

    const tcpSocket = report.sockets.find(
      (s) => s.protocol === 'tcp' && s.localPort === tcpPort && s.owner.pid === process.pid,
    );
    assert.ok(tcpSocket, 'own TCP listener attributed');
    assert.equal(tcpSocket.state, 'LISTEN');
    assert.equal(tcpSocket.localAddress, '127.0.0.1');
    assert.equal(tcpSocket.owner.startTicks, ticks);

    const udpSocket = report.sockets.find((s) => s.protocol === 'udp' && s.localPort === udpPort);
    assert.ok(udpSocket, 'own UDP socket attributed');
    assert.equal(udpSocket.family, 'ipv4');

    for (const socket of report.sockets) {
      assert.equal(socket.owner.startTicks, ticks, 'every socket carries a verified identity');
    }
  } finally {
    await witness.close();
    await new Promise((resolve) => server.close(resolve));
    udp.close();
  }
});

test('a stale start tick is refused and yields no sockets', { skip: !SOCKET_WITNESS_SUPPORTED }, async () => {
  const ticks = await readProcessStartTicks(process.pid);
  const witness = startSocketWitness({
    tracker: trackerFor(process.pid, ticks + 1),
    intervalMs: 60_000,
  });
  await witness.sample();
  const report = await witness.close();
  assert.equal(report.sockets.length, 0);
  assert.equal(
    report.errors.some((e) => e.code === 'identity-mismatch'),
    true,
    'identity mismatch is reported',
  );
});

test('an unavailable pid is an error, not a crash and not a claim', { skip: !SOCKET_WITNESS_SUPPORTED }, async () => {
  const witness = startSocketWitness({ tracker: trackerFor(4_000_000_000, 1), intervalMs: 60_000 });
  await witness.sample();
  const report = await witness.close();
  assert.equal(report.sockets.length, 0);
  assert.equal(report.absenceEstablished, false);
  assert.equal(report.errors.some((e) => e.code === 'process-unavailable'), true);
});

test('invalid tracker entries are rejected explicitly', { skip: !SOCKET_WITNESS_SUPPORTED }, async () => {
  const tracker = {
    async sample() {
      return { processes: [{ pid: 'x', startTicks: 1 }, { pid: 42 }, null], limitations: [] };
    },
  };
  const witness = startSocketWitness({ tracker, intervalMs: 60_000 });
  await witness.sample();
  const report = await witness.close();
  assert.equal(report.errors.filter((e) => e.code === 'invalid-identity').length >= 2, true);
});

test('close is idempotent and returns one report', { skip: !SOCKET_WITNESS_SUPPORTED }, async () => {
  const ticks = await readProcessStartTicks(process.pid);
  const witness = startSocketWitness({ tracker: trackerFor(process.pid, ticks), intervalMs: 60_000 });
  const first = await witness.close();
  const second = await witness.close();
  assert.equal(first, second);
  assert.equal(first.finished !== undefined, true);
});

test('non-linux platforms refuse to start', { skip: SOCKET_WITNESS_SUPPORTED }, () => {
  assert.throws(() => startSocketWitness({ tracker: trackerFor(1, 1) }), /Linux/);
});
