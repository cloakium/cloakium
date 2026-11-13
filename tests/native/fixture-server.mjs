import http from 'node:http';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./fixture-page.html', import.meta.url));

export async function startFixture() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/headers') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(request.headers));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(page);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Dual-stack so both 127.0.0.1 and localhost (::1) resolve to the fixture.
    server.listen(0, resolve);
  });

  const { port } = server.address();
  return {
    port,
    urlFor: (host) => `http://${host}:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
