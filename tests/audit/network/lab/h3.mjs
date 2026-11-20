import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { fixtureEnv, privateRoot, withDeadline } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const TOOL_TARGET = path.join(REPO_ROOT, "tools", "audit-h3-lab", "target");
const STARTUP_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 2_000;

/** CLOAKIUM_H3_BIN wins; otherwise the in-repo tool's release/debug target. */
function binaryCandidates() {
  const fromEnv = process.env.CLOAKIUM_H3_BIN ? [process.env.CLOAKIUM_H3_BIN] : [];
  return [
    ...fromEnv,
    path.join(TOOL_TARGET, "release", "cloakium-lab-h3"),
    path.join(TOOL_TARGET, "debug", "cloakium-lab-h3"),
  ];
}

const BUILD_HINT =
  "build it with: cargo build --release --manifest-path tools/audit-h3-lab/Cargo.toml (or set CLOAKIUM_H3_BIN to an existing binary)";

/** One STATS round trip over the loopback control socket. */
function controlRequest(port, command) {
  return withDeadline(
    new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`${command}\n`));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        socket.end();
        const line = buffer.split("\n")[0];
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(new Error(`control channel returned non-JSON: ${error.message}`));
        }
      });
      socket.on("error", reject);
      socket.setTimeout(CONTROL_TIMEOUT_MS, () => {
        socket.destroy();
        reject(new Error("control channel timeout"));
      });
    }),
    CONTROL_TIMEOUT_MS,
    "h3 control",
  );
}

/**
 * Spawn the owned loopback HTTP/3 fixture. Returns an unavailable handle rather
 * than throwing when the binary has not been built.
 */
export async function startH3({ certDir = null } = {}) {
  const binary = binaryCandidates().find((candidate) => candidate);
  const ownCertDir = certDir ? null : await mkdtemp(path.join(privateRoot(), "cloakium-h3-cert-")).catch(() => null);
  const directory = certDir ?? ownCertDir;
  const args = directory ? ["--cert-dir", directory] : [];

  let child;
  try {
    child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: fixtureEnv() });
  } catch (error) {
    return { available: false, reason: `cannot start ${binary}: ${error.message}`, buildHint: BUILD_HINT };
  }

  const failure = await withDeadline(
    new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const lines = createInterface({ input: child.stdout });
      lines.once("line", (line) => {
        try {
          finish({ startup: JSON.parse(line) });
        } catch (error) {
          finish({ error: `unparseable startup line: ${error.message}` });
        }
      });
      child.once("exit", (code) => finish({ error: `fixture exited early (code ${code})` }));
      child.once("error", (error) => finish({ error: error.message }));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) process.stderr.write(`[h3-lab] ${text}\n`);
      });
    }),
    STARTUP_TIMEOUT_MS,
    "h3 startup",
  ).catch((error) => ({ error: error.message }));

  if (!failure?.startup) {
    child.kill("SIGKILL");
    if (ownCertDir) await rm(ownCertDir, { recursive: true, force: true }).catch(() => {});
    return { available: false, reason: failure?.error ?? "unknown startup failure", buildHint: BUILD_HINT };
  }

  const { udpPort, tcpPort, controlPort, spkiSha256, certPath } = failure.startup;
  let closed = false;

  return {
    available: true,
    reason: null,
    binary,
    origin: `https://127.0.0.1:${udpPort}`,
    url: `https://127.0.0.1:${udpPort}/`,
    udpPort,
    tcpPort: tcpPort ?? null,
    controlPort,
    spkiSha256,
    certPath: certPath ?? directory ?? null,
    forceQuicOrigin: `127.0.0.1:${udpPort}`,
    pid: child.pid,
    async stats() {
      try {
        return await controlRequest(controlPort, "STATS");
      } catch (error) {
        return { error: error.message, connections: null, requests: null, peerPorts: [], peerAddrs: [] };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await controlRequest(controlPort, "SHUTDOWN");
      } catch {
        child.kill("SIGTERM");
      }
      await withDeadline(
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", resolve);
          setTimeout(resolve, SHUTDOWN_GRACE_MS);
        }),
        SHUTDOWN_GRACE_MS + 500,
        "h3 shutdown",
      ).catch(() => {});
      if (child.exitCode === null) child.kill("SIGKILL");
      if (ownCertDir) await rm(ownCertDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
