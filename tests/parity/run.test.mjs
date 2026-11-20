import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

function run(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: "/nonexistent" };
    delete env.CLOAKIUM_BINARY_PATH;
    delete env.CLOAKIUM_PARITY_PRIVATE_DISPLAY;
    const child = spawn(process.execPath, [runner, ...args], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "cloakium-run-"));
}

function executable(directory, name = "cloakium-chromium") {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

// PATH is intentionally empty of xvfb-run/openbox: any case that reaches the
// private display would fail with a different message than the CLI validation.
test("--help runs without a binary or a display", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--native-defaults/);
  assert.match(result.stdout, /--window-manager none\|openbox/);
});

test("a missing binary is rejected before any display starts", async () => {
  const started = Date.now();
  const result = await run(["--binary", "/nonexistent/cloakium-chromium"]);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 10_000, "rejection must not wait for a display");
  assert.match(result.stderr, /must point to the patched browser/);
  assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
});

test("an output directory is rejected before any display starts", async () => {
  const directory = temporaryDirectory();
  try {
    const result = await run(["--binary", executable(directory), "--output", directory]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /regular file path/);
    assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("non-executable and directory binaries are rejected before any display starts", async () => {
  const directory = temporaryDirectory();
  try {
    const plain = join(directory, "plain");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    const notExecutable = await run(["--binary", plain]);
    assert.notEqual(notExecutable.code, 0);
    assert.match(notExecutable.stderr, /not executable/);
    const directoryBinary = await run(["--binary", directory]);
    assert.notEqual(directoryBinary.code, 0);
    assert.match(directoryBinary.stderr, /executable file/);
    for (const result of [notExecutable, directoryBinary]) {
      assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an out-of-range repeat is rejected before any display starts", async () => {
  const directory = temporaryDirectory();
  try {
    for (const repeat of ["9", "0", "1.5"]) {
      const result = await run(["--binary", executable(directory), "--repeat", repeat]);
      assert.notEqual(result.code, 0, `--repeat ${repeat} must fail`);
      assert.match(result.stderr, /--repeat must be 1\.\.5/);
      assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an unmatched probe selection fails before any display starts", async () => {
  const directory = temporaryDirectory();
  try {
    const result = await run(["--binary", executable(directory), "--select", "no-such-probe/"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /No parity probes selected/);
    assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("unknown arguments are rejected", async () => {
  const result = await run(["--bogus"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown argument --bogus/);
});

test("an invalid window manager is rejected before any display starts", async () => {
  const directory = temporaryDirectory();
  try {
    const result = await run(["--binary", executable(directory), "--window-manager", "twm"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--window-manager must be one of none, openbox/);
    assert.doesNotMatch(result.stderr, /xvfb-run|Private headed baseline/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("--window-manager without a value is rejected", async () => {
  const result = await run(["--window-manager"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--window-manager needs a value/);
});
