// Shared probe-origin fixture: one loopback HTTP origin per plan, explicit-port
// refusal, idempotent close. No browser is launched.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startSharedProbeFixture, SHARED_FIXTURE_SCHEMA, SHARED_FIXTURE_OWNERSHIP } from './fixtures.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('a shared fixture exposes one loopback origin and a verifiable receipt', async () => {
  const fixture = await startSharedProbeFixture();
  try {
    assert.equal(fixture.schema, SHARED_FIXTURE_SCHEMA);
    assert.equal(fixture.ownership, SHARED_FIXTURE_OWNERSHIP);
    assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(fixture.crossOrigin, /^http:\/\/(?:\[::1\]|localhost):\d+$/);
    assert.ok(Number.isInteger(fixture.port) && fixture.port > 0);
    assert.equal(fixture.receipt.port, fixture.port);
    assert.equal(fixture.receipt.urls.origin, fixture.origin);
    assert.equal(fixture.receipt.urls.crossOrigin, fixture.crossOrigin);
    assert.match(fixture.receipt.sha256, /^[0-9a-f]{64}$/);
    assert.equal(fixture.receipt.loopbackOnly, true);
    assert.deepEqual(fixture.endpoints.map((entry) => entry.name), ['origin', 'cross-origin']);

    const response = await fetch(`${fixture.origin}/identity`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const stats = fixture.originStats();
    assert.ok(stats.requests.some((entry) => entry.path === '/identity'));
  } finally {
    await fixture.close();
  }
});

test('close is idempotent, bounded and reports the actual origin', async () => {
  const fixture = await startSharedProbeFixture();
  const [first, second] = await Promise.all([fixture.close(), fixture.close()]);
  assert.equal(first, second, 'concurrent close shares one receipt');
  assert.equal(first.closed, true);
  assert.equal(first.sha256, fixture.receipt.sha256);
  const third = await fixture.close();
  assert.equal(third, first);
});

test('an occupied explicit replay port is refused and the foreign server survives', async () => {
  const foreign = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('foreign');
  });
  const port = await listen(foreign);
  try {
    await assert.rejects(
      startSharedProbeFixture({ port }),
      (error) => ['shared-fixture-port-unavailable', 'shared-fixture-port-mismatch'].includes(error.code)
    );
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(body, 'foreign', 'the fixture never kills or adopts a foreign listener');
  } finally {
    await close(foreign);
  }
});

test('an explicit free port is honoured when the origin factory supports it', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);

  const fakeOrigin = {
    port,
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://[::1]:${port}`,
    crossOriginMode: 'fixture',
    stats: () => ({ hits: {}, requests: [] }),
    close: async () => {}
  };
  const fixture = await startSharedProbeFixture({ port }, { originFactory: async (options) => {
    assert.deepEqual(options, { port });
    return fakeOrigin;
  } });
  assert.equal(fixture.port, port);
  assert.equal(fixture.receipt.requestedPort, port);
  await fixture.close();
});

test('an origin factory that ignores the explicit port is refused, not silently accepted', async () => {
  const fakeOrigin = {
    port: 65001,
    origin: 'http://127.0.0.1:65001',
    crossOrigin: 'http://[::1]:65001',
    crossOriginMode: 'fixture',
    stats: () => ({ hits: {}, requests: [] }),
    close: async () => {}
  };
  await assert.rejects(
    startSharedProbeFixture({ port: 65000 }, { originFactory: async () => fakeOrigin }),
    (error) => error.code === 'shared-fixture-port-mismatch'
  );
});

test('a non-loopback origin report is refused', async () => {
  const fakeOrigin = {
    port: 41001,
    origin: 'http://example.test:41001',
    crossOrigin: 'http://example.test:41002',
    crossOriginMode: 'fixture',
    stats: () => ({ hits: {}, requests: [] }),
    close: async () => {}
  };
  await assert.rejects(
    startSharedProbeFixture({}, { originFactory: async () => fakeOrigin }),
    (error) => error.code === 'shared-fixture-not-loopback'
  );
});

test('invalid port input is rejected before any bind', async () => {
  for (const port of [-1, 65536, 1.5, '80', null]) {
    await assert.rejects(startSharedProbeFixture({ port }), (error) => error.code === 'shared-fixture-invalid-port');
  }
});

test('a bind failure is wrapped without leaking driver text', async () => {
  const fixtureFactory = async () => { throw new Error('bind failed: credential-looking detail'); };
  await assert.rejects(
    startSharedProbeFixture({}, { originFactory: fixtureFactory }),
    (error) => error.code === 'shared-fixture-bind-failed' && !String(error.message).includes('credential-looking')
  );
});
