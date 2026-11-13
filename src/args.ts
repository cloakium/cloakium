/**
 * Chromium command-line assembly: stealth defaults < caller args < dedicated
 * options, deduplicated by `--key`. Only real switches are emitted; locale and
 * timezone travel through Playwright's context options.
 */

import path from "node:path";

import { getDefaultStealthArgs, randomSeed } from "./config.js";
import type { LaunchOptions } from "./types.js";

const DEBUG = /\bcloakium\b/.test(process.env.DEBUG ?? "");

function setArg(
  seen: Map<string, string>,
  arg: string,
  overriddenNote?: string,
): void {
  const key = arg.split("=")[0]!;
  if (seen.has(key) && DEBUG) {
    console.debug(`[cloakium] ${overriddenNote ?? "arg override"}: ${seen.get(key)} -> ${arg}`);
  }
  seen.set(key, arg);
}

/**
 * Build deduplicated Chromium args from the stealth defaults plus caller
 * overrides. Returns a new array on every call.
 */
export function buildArgs(options: LaunchOptions): string[] {
  const seen = new Map<string, string>();

  if (options.stealthArgs !== false) {
    const seed = options.fingerprintSeed ?? randomSeed();
    for (const arg of getDefaultStealthArgs(seed)) setArg(seen, arg);
  }

  // Default is headless; only an explicit `headless: false` is a headed launch.
  const headed = options.headless === false;
  const windows = process.platform === "win32";
  if (headed || windows) setArg(seen, "--ignore-gpu-blocklist");

  for (const arg of options.args ?? []) setArg(seen, arg);

  if (options.extensionPaths?.length) {
    const joined = options.extensionPaths.map((p) => path.resolve(p)).join(",");
    setArg(seen, `--load-extension=${joined}`);
    setArg(seen, `--disable-extensions-except=${joined}`);
  }

  // A real Chrome window is usually maximized; never in headless mode.
  const explicitViewport = (options as { viewport?: unknown }).viewport !== undefined;
  let hasWindowFlag = false;
  for (const key of ["--start-maximized", "--window-size", "--window-position"]) {
    if (seen.has(key)) hasWindowFlag = true;
  }
  if (headed && !explicitViewport && !hasWindowFlag) {
    setArg(seen, "--start-maximized");
  }

  return [...seen.values()];
}

/** @internal exposed for tests. */
export { getDefaultStealthArgs };
