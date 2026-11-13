/**
 * Browser availability for the suites. Nothing is downloaded: the tests use
 * whatever `CLOAKIUM_BINARY_PATH` / `CLOAKBROWSER_BINARY_PATH` /
 * `cloakium-chromium` on `PATH` resolves to.
 */

import { tryResolveBinaryPath } from "../../dist/index.js";

export function detectBinary() {
  try {
    return tryResolveBinaryPath();
  } catch {
    return undefined;
  }
}

/**
 * The suites launch a real Chromium. Hosts whose sandbox cannot start (some
 * containers) can opt into `--no-sandbox` explicitly with
 * `CLOAKIUM_TEST_NO_SANDBOX=1`; the wrapper itself never adds it.
 */
export function sandboxArgs() {
  return process.env.CLOAKIUM_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
}

export const browserAvailable = detectBinary() !== undefined;