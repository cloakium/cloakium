// Browser configuration without downloads or background updates.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const WRAPPER_VERSION = readVersion();

// Keep SwiftShader available on GPU-less hosts.
export const IGNORE_DEFAULT_ARGS = ["--enable-automation"];

export const SEED_MIN = 10000;
export const SEED_MAX = 99999;

export function randomSeed(): number {
  const span = SEED_MAX - SEED_MIN + 1;
  return SEED_MIN + Math.floor(Math.random() * span);
}

// Concurrent first launches derive the same seed before publication.
export function seedForProfile(profilePath: string): number {
  let h = 2166136261;
  for (let i = 0; i < profilePath.length; i += 1) {
    h ^= profilePath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SEED_MIN + (Math.abs(h) % (SEED_MAX - SEED_MIN + 1));
}

/** Host platform tag, for diagnostics only — never used to spoof another OS. */
export function getPlatformTag(): string {
  const { platform, arch } = process;
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "win32") return "windows-x64";
  return `${platform}-${arch}`;
}

// Chrome's preference switch; the content-shell `force-` variant is inert here.
export const WEBRTC_IP_HANDLING_SWITCH = "webrtc-ip-handling-policy";
export const WEBRTC_IP_HANDLING_POLICY = "disable_non_proxied_udp";
export const WEBRTC_IP_HANDLING_ARG =
  `--${WEBRTC_IP_HANDLING_SWITCH}=${WEBRTC_IP_HANDLING_POLICY}`;
// Caller arguments override either default by key.
export function getDefaultStealthArgs(seed?: string | number): string[] {
  return [
    `--fingerprint=${seed ?? randomSeed()}`,
    WEBRTC_IP_HANDLING_ARG,
  ];
}
