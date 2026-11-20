import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const displayTimeoutMs = 7_200_000;
const teardownGraceMs = 5_000;
const displayVariables = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];

// Playwright adds these only to headless launches; removing them exposes the
// browser's own defaults instead of the driver's automation defaults.
export const implicitHeadlessDefaults = [
  "--hide-scrollbars",
  "--mute-audio",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

export const windowManagers = ["none", "openbox"];

// The headed reference is a controlled private display. Without an OS window
// manager the window is Chrome's own, so headed and headless geometry agree.
export function displayReference(windowManager) {
  if (!windowManagers.includes(windowManager)) {
    throw new Error(`--window-manager must be one of ${windowManagers.join(", ")}: ${windowManager}`);
  }
  return {
    display: "private Xvfb",
    screen: "1920x1080x24",
    dpi: 96,
    windowManager,
    decorations: windowManager === "none" ? "none" : "window-manager",
  };
}

export function browserEnvironment(mode, base = process.env) {
  const env = { ...base };
  if (mode === "headless") for (const name of displayVariables) delete env[name];
  return env;
}

export function browserLaunchOptions({ binary, mode, nativeDefaults, baseEnv = process.env }) {
  return {
    executablePath: binary,
    headless: mode === "headless",
    chromiumSandbox: true,
    timeout: 20_000,
    ignoreDefaultArgs: nativeDefaults
      ? ["--enable-automation", ...implicitHeadlessDefaults]
      : ["--enable-automation"],
    env: browserEnvironment(mode, baseEnv),
  };
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid, signal) {
  if (!pgid) return;
  try { process.kill(-pgid, signal); } catch { /* the whole group is already gone */ }
}

async function stopGroup(pgid, graceMs) {
  if (!pgid) return;
  signalGroup(pgid, "SIGTERM");
  const gracefulDeadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < gracefulDeadline) await delay(25);
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, "SIGKILL");
  const forcedDeadline = Date.now() + 1_000;
  while (groupAlive(pgid) && Date.now() < forcedDeadline) await delay(25);
}

async function bounded(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Runs a launcher in its own process group so a timeout or signal can stop the
// launcher and every process it started without touching unrelated processes.
export async function runDisplay(command, args, options = {}) {
  const { env = process.env, timeoutMs = displayTimeoutMs, graceMs = teardownGraceMs } = options;
  const child = spawn(command, args, { stdio: "inherit", env, detached: true });
  const pgid = child.pid;
  let settled = false;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    resolveExit(result);
  };
  child.once("exit", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => settle({ error }));

  let received;
  let teardown = Promise.resolve();
  const handlers = new Map();
  const removeHandlers = () => {
    for (const [name, handler] of handlers) process.off(name, handler);
    handlers.clear();
  };
  const exitCodeFor = (name) => 128 + (osConstants.signals[name] ?? 0);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (received) {
        signalGroup(pgid, "SIGKILL");
        process.exit(exitCodeFor(name));
      }
      received = name;
      teardown = stopGroup(pgid, graceMs);
      void teardown.finally(() => process.exit(exitCodeFor(name)));
    };
    handlers.set(name, handler);
    process.on(name, handler);
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([exited, timeout]);
  } finally { clearTimeout(timer); }
  if (result.timedOut) {
    await stopGroup(pgid, graceMs);
    result = { timedOut: true, ...(await bounded(exited, graceMs, { code: null, signal: "SIGKILL", abandoned: true })) };
  }
  if (received) {
    // The signal handler owns termination and its exit status.
    await teardown;
    process.exit(exitCodeFor(received));
  }
  removeHandlers();
  return { pid: pgid, ...result };
}

export async function enterPrivateDisplay(script, args) {
  if (process.env.CLOAKIUM_PARITY_PRIVATE_DISPLAY === "1") return;
  const env = { ...process.env, CLOAKIUM_PARITY_PRIVATE_DISPLAY: "1", XDG_SESSION_TYPE: "x11" };
  delete env.WAYLAND_DISPLAY;
  const result = await runDisplay("xvfb-run", [
    "-a", "-s", "-screen 0 1920x1080x24 -dpi 96",
    process.execPath, script, ...args,
  ], { env });
  if (result.error) throw new Error(`Private headed baseline needs xvfb-run: ${result.error.message}`);
  if (result.timedOut) {
    console.error(`Private headed baseline exceeded ${displayTimeoutMs} ms; its process group was terminated`);
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

export async function startWindowManager(log) {
  if (!process.env.DISPLAY) throw new Error("The private test display is missing");
  const fd = openSync(log, "w");
  const child = spawn("openbox", ["--sm-disable"], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let spawnError;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  child.once("error", (error) => { spawnError = error; resolveExit(); });
  child.once("exit", resolveExit);
  const stop = async () => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try { await bounded(exited, 5_000, undefined); } finally { clearTimeout(timer); }
  };
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null) {
      throw new Error(`Openbox could not start: ${spawnError?.message ?? readFileSync(log, "utf8")}`);
    }
    const probe = spawnSync("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], {
      encoding: "utf8", timeout: 1_000,
    });
    if (probe.error) {
      await stop();
      throw new Error(`xprop is required to verify window-manager readiness: ${probe.error.message}`);
    }
    if (probe.status === 0 && /window id # 0x[0-9a-f]+/i.test(probe.stdout)) return { stop };
    await delay(50);
  }
  await stop();
  throw new Error(`Openbox did not become ready; see ${log}`);
}
