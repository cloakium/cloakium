import { createServer } from "node:http";
import { once } from "node:events";

const frame = `<!doctype html><html><head><title>Parity frame</title></head><body>
<label>Frame text<input id="frame-input" aria-label="Frame text"></label>
<button id="frame-button">Frame button</button>
<script>document.querySelector("button").onclick=()=>document.body.dataset.clicked="yes";</script>
</body></html>`;
const serviceWorker = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === "/service-worker-resource")
    event.respondWith(new Response("service-worker-intercepted", {headers: {"Content-Type": "text/plain"}}));
});`;

export async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/headers") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(request.headers));
    } else if (url.pathname === "/download") {
      response.setHeader("Content-Type", "text/plain");
      response.setHeader("Content-Disposition", 'attachment; filename="parity.txt"');
      response.end("Cloakium parity download\n");
    } else if (url.pathname === "/service-worker.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.setHeader("Service-Worker-Allowed", "/");
      response.end(serviceWorker);
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(url.pathname === "/frame" ? frame : "<!doctype html><title>Cloakium parity</title><body></body>");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://localhost:${port}`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
