/**
 * Browser binary resolution. Fail closed: no download, no Playwright-managed
 * fallback.
 *
 * Order: `CLOAKIUM_BINARY_PATH`, then legacy `CLOAKBROWSER_BINARY_PATH`, then
 * a `cloakium-chromium` executable on `PATH`.
 */

import fs from "node:fs";
import path from "node:path";

import { BinaryNotFoundError } from "./errors.js";

export const BINARY_ENV_VARS = ["CLOAKIUM_BINARY_PATH", "CLOAKBROWSER_BINARY_PATH"] as const;

export const PATH_BINARY_NAME = "cloakium-chromium";

function suffixes(): string[] {
  return process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigured(value: string): string {
  const absolute = path.resolve(value);
  if (!isExecutableFile(absolute)) {
    throw new BinaryNotFoundError(
      `[cloakium] browser binary ${absolute} is missing or not executable. ` +
        "Point CLOAKIUM_BINARY_PATH at the patched Chromium executable.",
    );
  }
  return fs.realpathSync(absolute);
}

function searchPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes()) {
      const candidate = path.join(entry, PATH_BINARY_NAME + suffix);
      if (isExecutableFile(candidate)) return fs.realpathSync(candidate);
    }
  }
  return undefined;
}

/** Resolve the executable, or `undefined` when nothing is configured. */
export function tryResolveBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of BINARY_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return resolveConfigured(value);
  }
  return searchPath(env.PATH);
}

/** Resolve the executable or throw `BinaryNotFoundError`. */
export function resolveBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = tryResolveBinaryPath(env);
  if (resolved !== undefined) return resolved;
  throw new BinaryNotFoundError(
    "[cloakium] no browser binary configured. Set CLOAKIUM_BINARY_PATH (or the " +
      `legacy CLOAKBROWSER_BINARY_PATH), or put \`${PATH_BINARY_NAME}\` on PATH. ` +
      "cloakium never downloads browsers.",
  );
}
