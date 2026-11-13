#!/usr/bin/env node
/**
 * Test entry point: build the package, run the suites in this process, then
 * repeat the same suites under Bun when a `bun` executable is available.
 *
 * Browser suites need a Chromium build; when none is configured they report
 * SKIP rather than failing, so the Node/Bun API checks always run.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const args = new Set(process.argv.slice(2));
const isBun = typeof process.versions.bun === "string";

if (!args.has("--no-build")) {
  const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const suites = [
  "api.test.mjs",
  "geoip.test.mjs",
  "hardening.test.mjs",
  "webrtc.test.mjs",
  "launch.test.mjs",
  "../human/human.test.mjs",
  "../human/reconfigure.test.mjs",
  "../human/budget.test.mjs",
  "../human/coverage.test.mjs",
];
for (const suite of suites) {
  await import(pathToFileURL(path.join(here, suite)).href);
}

const { run } = await import(pathToFileURL(path.join(here, "harness.mjs")).href);
const result = await run({ label: isBun ? "bun" : "node" });

if (!isBun && !args.has("--no-bun")) {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    const child = spawnSync(
      "bun",
      [fileURLToPath(import.meta.url), "--no-build", "--no-bun"],
      { cwd: root, stdio: "inherit" },
    );
    if (child.status !== 0) process.exit(child.status ?? 1);
  } else {
    console.log("bun not found on PATH; skipped the Bun run");
  }
}

process.exit(result.failed === 0 ? 0 : 1);
