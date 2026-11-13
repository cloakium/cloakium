/**
 * WebRTC egress privacy: default launches disable non-proxied UDP, so a page
 * cannot reach a STUN server directly. The probe and its responder are
 * localhost-only; nothing leaves the machine and no address is printed.
 */

import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";

import { buildLaunchOptions, getDefaultStealthArgs, launch } from "../../dist/index.js";
import { browserAvailable, sandboxArgs } from "./browser-env.mjs";
import { skip, test } from "./harness.mjs";

const POLICY = "disable_non_proxied_udp";
const CHROME_FLAG = `--webrtc-ip-handling-policy=${POLICY}`;
const MAGIC = 0x2112a442;
const TEST_TIMEOUT_MS = 45_000;
const GATHER_TIMEOUT_MS = 8_000;

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** `buildLaunchOptions` resolves the host binary, so point it at anything executable. */
async function launchOptions(options) {
  const saved = process.env.CLOAKIUM_BINARY_PATH;
  process.env.CLOAKIUM_BINARY_PATH = process.execPath;
  try {
    return await buildLaunchOptions(options);
  } finally {
    if (saved === undefined) delete process.env.CLOAKIUM_BINARY_PATH;
    else process.env.CLOAKIUM_BINARY_PATH = saved;
  }
}

/** Minimal STUN binding responder so Chromium can gather an srflx candidate. */
async function startStunResponder() {
  const socket = dgram.createSocket("udp4");
  const stats = { requests: 0, responses: 0 };

  socket.on("message", (message, rinfo) => {
    if (
      message.length < 20 ||
      message.readUInt16BE(0) !== 0x0001 ||
      message.readUInt32BE(4) !== MAGIC
    ) {
      return;
    }
    stats.requests += 1;
    const transaction = message.subarray(8, 20);
    const address = Buffer.alloc(8);
    address[1] = 0x01;
    address.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 2);
    const octets = rinfo.address.split(".").map(Number);
    const packed =
      ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    address.writeUInt32BE((packed ^ MAGIC) >>> 0, 4);

    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0);
    header.writeUInt16BE(12, 2);
    header.writeUInt32BE(MAGIC, 4);
    transaction.copy(header, 8);
    const attribute = Buffer.alloc(4);
    attribute.writeUInt16BE(0x0020, 0);
    attribute.writeUInt16BE(8, 2);
    const response = Buffer.concat([header, attribute, address]);

    socket.send(response, rinfo.port, rinfo.address, (error) => {
      if (!error) stats.responses += 1;
    });
  });

  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  return {
    port: socket.address().port,
    stats,
    close: () =>
      new Promise((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

function probePage(stunPort) {
  return `<!doctype html><meta charset="utf-8"><script>
window.probe = () => new Promise((resolve) => {
  const candidates = [];
  let settled = false;
  let pc;
  const finish = (reason) => {
    if (settled) return;
    settled = true;
    try { pc.close(); } catch {}
    resolve({ reason, candidates });
  };
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }],
  });
  pc.onicecandidate = (event) => {
    if (!event.candidate) return finish("null-candidate");
    candidates.push({ type: event.candidate.type, protocol: event.candidate.protocol });
  };
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === "complete") finish("complete");
  };
  pc.createDataChannel("probe");
  pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  setTimeout(() => finish("timeout"), ${GATHER_TIMEOUT_MS});
});
</script>`;
}

async function startPageServer(stunPort) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(probePage(stunPort));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Run the in-page probe in a real browser and return its observations. */
async function probe(options) {
  const stun = await startStunResponder();
  const pages = await startPageServer(stun.port);
  let browser;
  try {
    browser = await launch({
      headless: true,
      args: sandboxArgs(),
      launchOptions: { timeout: 60_000 },
      ...options,
    });
    const page = await browser.newPage();
    try {
      await page.goto(pages.url);
      const result = await page.evaluate(() => window.probe());
      return { ...result, ...stun.stats };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await pages.close();
    await stun.close();
  }
}

test("default privacy args request the WebRTC IP handling policy", () => {
  const args = getDefaultStealthArgs("4242");
  assert.deepEqual(args, ["--fingerprint=4242", CHROME_FLAG]);
  assert.equal(args.filter((arg) => arg.includes("webrtc-ip-handling-policy")).length, 1);
  assert.equal(args.some((arg) => arg.startsWith("--force-webrtc-ip-handling-policy")), false);
  for (const forbidden of ["--no-sandbox", "--fingerprint-platform", "--lang", "--fingerprint-timezone"]) {
    assert.equal(args.some((arg) => arg.startsWith(forbidden)), false, `unexpected ${forbidden}`);
  }
});

test("a caller arg replaces the WebRTC policy switch by key", async () => {
  const options = await launchOptions({
    fingerprintSeed: "11111",
    args: [
      `--webrtc-ip-handling-policy=default`,
    ],
  });
  const webRtc = options.args.filter((arg) => arg.includes("webrtc-ip-handling-policy"));
  assert.deepEqual(webRtc.sort(), [
    "--webrtc-ip-handling-policy=default",
  ]);
  assert.equal(options.args.includes(CHROME_FLAG), false);
  assert.ok(options.args.includes("--fingerprint=11111"));
});

test("stealthArgs: false leaves privacy switches out", async () => {
  const options = await launchOptions({ stealthArgs: false, fingerprintSeed: "11111" });
  assert.equal(options.args.some((arg) => arg.startsWith("--fingerprint")), false);
  assert.equal(options.args.some((arg) => arg.includes("webrtc-ip-handling-policy")), false);
});

contract("baseline: a page can reach a local STUN responder over UDP", async () => {
  await withTimeout(
    (async () => {
      const result = await probe({ stealthArgs: false });
      assert.equal(result.reason, "complete", "ICE gathering must finish");
      assert.ok(result.requests >= 1, "the baseline browser must send a STUN binding request");
      assert.ok(
        result.candidates.some((candidate) => candidate.type === "srflx"),
        "the baseline browser must gather a server-reflexive UDP candidate",
      );
    })(),
    TEST_TIMEOUT_MS,
    "baseline WebRTC probe",
  );
});

contract("default: non-proxied UDP cannot leave the page", async () => {
  await withTimeout(
    (async () => {
      const result = await probe({ fingerprintSeed: "12345" });
      assert.equal(result.reason, "complete", "ICE gathering must finish, not hang");
      assert.equal(result.requests, 0, "no STUN request may reach a non-proxied UDP server");
      assert.equal(result.responses, 0);
      assert.equal(
        result.candidates.some((candidate) => candidate.type === "srflx"),
        false,
        "no server-reflexive candidate may be gathered",
      );
    })(),
    TEST_TIMEOUT_MS,
    "hardened WebRTC probe",
  );
});
