import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function run(args) {
  const env = { ...process.env };
  delete env.CLOAKIUM_BINARY_PATH;
  delete env.CLOAKIUM_PARITY_PRIVATE_DISPLAY;
  const result = spawnSync(process.execPath, ["tests/parity/fullscreen.mjs", ...args], {
    cwd: new URL("../..", import.meta.url),
    env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

test("fullscreen help has no machine-specific browser fallback", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /CLOAKIUM_BINARY_PATH/);
  assert.doesNotMatch(result.stdout, /\/nix\/store\//);
});

test("fullscreen requires an explicit browser before creating a display", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must select the tested browser/);
});

test("fullscreen rejects invalid output and arguments before display startup", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloakium-fullscreen-cli-"));
  try {
    const output = run(["--binary", process.execPath, "--output", directory]);
    assert.notEqual(output.status, 0);
    assert.match(output.stderr, /regular file path/);
    const unknown = run(["--unknown"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown argument/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
