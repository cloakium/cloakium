import assert from "node:assert/strict";
import { get } from "node:http";
import test from "node:test";
import { startFixture } from "./fixture-server.mjs";

async function request(url, headers = {}) {
  return await new Promise((resolve, reject) => {
    const request = get(url, { headers, timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ body, headers: response.headers, status: response.statusCode }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Local parity fixture timed out")));
    request.on("error", reject);
  });
}

test("one loopback fixture provides stable origins and real request-header observations", async () => {
  const fixture = await startFixture();
  try {
    assert.equal(new URL(fixture.origin).hostname, "127.0.0.1");
    assert.equal(new URL(fixture.crossOrigin).hostname, "localhost");
    assert.equal(new URL(fixture.origin).port, new URL(fixture.crossOrigin).port);
    const response = await request(`${fixture.origin}/headers`, { "User-Agent": "parity-probe" });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body)["user-agent"], "parity-probe");
    assert.equal(response.headers["cache-control"], "no-store");
  } finally { await fixture.close(); }
});

test("download and frame fixtures have the contracts used by interaction probes", async () => {
  const fixture = await startFixture();
  try {
    const download = await request(`${fixture.origin}/download`);
    assert.equal(download.headers["content-disposition"], 'attachment; filename="parity.txt"');
    assert.equal(download.body, "Cloakium parity download\n");
    const frame = await request(`${fixture.origin}/frame`);
    assert.match(frame.body, /id="frame-input"/);
    assert.match(frame.body, /id="frame-button"/);
  } finally { await fixture.close(); }
});
