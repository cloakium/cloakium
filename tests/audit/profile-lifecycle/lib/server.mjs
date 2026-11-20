// Loopback fixture server for the profile-lifecycle scenarios.
//
// Binds port 0 on 127.0.0.1, tracks every socket, and closes deterministically:
// sockets are destroyed first so `server.close()` cannot wait on keep-alive
// connections. All content is local and static; no remote fetches are possible
// because nothing in the fixture references an external origin.

import http from 'node:http';

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Profile lifecycle lab fixture</title></head>
<body><main id="fixture" data-lab-fixture="profile-lifecycle">local fixture</main></body></html>`;

export async function startLabServer({ maxRequests = 200 } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (requests.length < maxRequests) requests.push({ path: url.pathname, method: request.method });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/health') {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
      return;
    }
    response.end(HTML);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port, address } = server.address();
  return {
    port,
    address,
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://localhost:${port}`,
    requests,
    socketCount: () => sockets.size,
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
