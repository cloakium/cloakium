#!/usr/bin/env node
/**
 * Build the package: clean `dist/`, then run `tsc -p tsconfig.json`.
 * Plain TypeScript emit — no bundling, so `src/**` module boundaries survive
 * into `dist/**` and deep imports stay debuggable.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", ".bin", "tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });

const result = spawnSync(tsc, ["-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[cloakium] failed to run tsc: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("[cloakium] build ok");
