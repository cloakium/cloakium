import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  browserEnvironment, browserLaunchOptions, displayReference, implicitHeadlessDefaults, runDisplay,
} from "./display.mjs";

const displayModule = new URL("./display.mjs", import.meta.url).href;

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "cloakium-display-"));
}

// A launcher with the same shape as xvfb-run: it forks a long-lived descendant
// and waits, so killing only the launcher would leave the descendant running.
function fakeLauncher(directory, pidFile) {
  const path = join(directory, "xvfb-run");
  writeFileSync(path, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(path, 0o755);
  return path;
}

async function waitForPid(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return Number(readFileSync(path, "utf8")); }
    catch { await delay(25); }
  }
  throw new Error(`fixture never wrote ${path}`);
}

function exited(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const timer = setTimeout(() => reject(new Error("child did not exit within the teardown budget")), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

// A zombie is already dead; only a runnable descendant is a leak.
function live(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = stat.slice(close + 2, close + 3);
    return state !== "Z" && state !== "X";
  } catch { return false; }
}

test("the headed reference states its window manager explicitly", () => {
  assert.deepEqual(displayReference("none"), {
    display: "private Xvfb", screen: "1920x1080x24", dpi: 96,
    windowManager: "none", decorations: "none",
  });
  assert.deepEqual(displayReference("openbox"), {
    display: "private Xvfb", screen: "1920x1080x24", dpi: 96,
    windowManager: "openbox", decorations: "window-manager",
  });
  assert.throws(() => displayReference("twm"), /none, openbox/);
});

test("headless launches drop display variables without mutating the base environment", () => {
  const base = { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/tmp/auth", PATH: "/bin" };
  assert.deepEqual(browserEnvironment("headless", base), { PATH: "/bin" });
  assert.equal(base.DISPLAY, ":1", "base environment must not be mutated");
  const headed = browserEnvironment("headed", base);
  assert.equal(headed.DISPLAY, ":1");
  assert.equal(headed.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(headed.XAUTHORITY, "/tmp/auth");
});

test("native defaults remove and report the driver's implicit headless arguments", () => {
  const base = { DISPLAY: ":1" };
  const native = browserLaunchOptions({ binary: "/bin/true", mode: "headless", nativeDefaults: true, baseEnv: base });
  assert.deepEqual(native.ignoreDefaultArgs, ["--enable-automation", ...implicitHeadlessDefaults]);
  assert.equal(native.headless, true);
  assert.equal(native.env.DISPLAY, undefined);
  const driverDefaults = browserLaunchOptions({ binary: "/bin/true", mode: "headed", nativeDefaults: false, baseEnv: base });
  assert.deepEqual(driverDefaults.ignoreDefaultArgs, ["--enable-automation"]);
  assert.equal(driverDefaults.headless, false);
  assert.equal(driverDefaults.env.DISPLAY, ":1");
  assert.equal(implicitHeadlessDefaults.length, 3);
});

test("a display timeout stops the launcher and all of its descendants", async () => {
  const directory = temporaryDirectory();
  const pidFile = join(directory, "grandchild.pid");
  const launcher = fakeLauncher(directory, pidFile);
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const started = Date.now();
    const result = await runDisplay(launcher, [], { env: process.env, timeoutMs: 1_000, graceMs: 3_000 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 15_000, "timeout teardown must be bounded");
    const grandchild = await waitForPid(pidFile, 5_000);
    assert.equal(live(grandchild), false, `descendant ${grandchild} survived teardown`);
    assert.equal(live(result.pid), false, `launcher ${result.pid} survived teardown`);
    assert.equal(live(bystander.pid), true, "an unrelated process must survive teardown");
  } finally {
    bystander.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a termination signal stops the launcher's whole process group", async () => {
  const directory = temporaryDirectory();
  const pidFile = join(directory, "grandchild.pid");
  const launcher = fakeLauncher(directory, pidFile);
  const runner = join(directory, "runner.mjs");
  writeFileSync(runner, `import { runDisplay } from ${JSON.stringify(displayModule)};\n` +
    `await runDisplay(process.env.PARITY_LAUNCHER, [], { env: process.env, timeoutMs: 60_000 });\n`);
  const child = spawn(process.execPath, [runner], {
    stdio: "ignore",
    env: { ...process.env, PARITY_LAUNCHER: launcher },
  });
  try {
    const grandchild = await waitForPid(pidFile);
    const closed = exited(child, 15_000);
    child.kill("SIGTERM");
    assert.notEqual(await closed, 0);
    assert.equal(live(grandchild), false, `descendant ${grandchild} survived the signal teardown`);
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing display launcher is a bounded spawn error, not a hang", async () => {
  const result = await runDisplay(join(tmpdir(), `cloakium-missing-launcher-${process.pid}`), [], {
    timeoutMs: 5_000,
  });
  assert.equal(result.error?.code, "ENOENT");
  assert.equal(result.timedOut, undefined);
  assert.equal(result.pid, undefined);
});
