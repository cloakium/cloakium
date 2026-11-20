import { bounded } from "./outcomes.mjs";
import { safeError } from "./secure-io.mjs";
import { createProcessTracker } from "./processes.mjs";

export function assertSandboxArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" ||
      /^--(?:no-sandbox|no-zygote|single-process|disable-[a-z0-9-]*sandbox|disable-web-security)(?:=|$)/i.test(arg) ||
      /^--disable-features=.*sandbox/i.test(arg)))
    throw new Error("Unsafe browser launch arguments");
}

export async function launchBrowser({
  chromium, executablePath, mode, args, env, ignoreDefaultArgs = [],
  launchProxy, startupMs = 60000, cleanupMs = 15000,
}, dependencies = {}) {
  assertSandboxArguments(args);
  if (!["headless", "headed"].includes(mode)) throw new Error("Explicit browser mode required");
  if (mode === "headless" && ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"].some(key => Object.hasOwn(env, key)))
    throw new Error("Headless browser must not inherit a display endpoint");
  let server;
  let browser;
  let tracker;
  let closing;
  const errors = [];
  const cleanup = {
    closed: false, forced: false, rootExited: false, remaining: [], limitations: [],
    transport: "playwright-websocket-over-browser-pipe",
  };
  const finish = async () => {
    if (closing) return closing;
    closing = (async () => {
      if (tracker) await tracker.sample();
      if (browser) {
        try { await bounded(() => browser.close(), cleanupMs, "browser disconnect"); }
        catch (error) { errors.push(safeError(error, "browser disconnect")); }
      }
      if (server) {
        try { await bounded(() => server.close(), cleanupMs, "browser server close"); }
        catch (error) {
          errors.push(safeError(error, "browser server close"));
          cleanup.forced = true;
          try { await bounded(() => server.kill(), cleanupMs, "browser server kill"); }
          catch (killError) { errors.push(safeError(killError, "browser server kill")); }
        }
        const child = server.process();
        cleanup.rootExited = child.exitCode !== null || child.signalCode !== null;
      }
      if (tracker) {
        cleanup.remaining = await tracker.waitGone(3000);
        if (cleanup.remaining.some(row => row.verification === "same-instance")) {
          cleanup.forced = true;
          await tracker.terminate("SIGTERM");
          cleanup.remaining = await tracker.waitGone(3000);
          if (cleanup.remaining.some(row => row.verification === "same-instance")) {
            await tracker.terminate("SIGKILL");
            cleanup.remaining = await tracker.waitGone(2000);
          }
        }
        cleanup.limitations = tracker.limitations;
      }
      cleanup.closed = !!server && cleanup.rootExited && cleanup.remaining.length === 0 &&
        cleanup.limitations.length === 0;
      if (errors.length) cleanup.errors = errors;
      return cleanup;
    })();
    return closing;
  };
  try {
    let abandoned = false;
    const pending = chromium.launchServer({
      executablePath, headless: mode === "headless", chromiumSandbox: true,
      args, env, ignoreDefaultArgs, timeout: startupMs,
      host: "127.0.0.1", port: 0, handleSIGINT: false, handleSIGTERM: false,
      ...(launchProxy ? { proxy: launchProxy } : {}),
    });
    pending.then(value => { if (abandoned) void value.kill().catch(() => {}); }).catch(() => {});
    try { server = await bounded(() => pending, startupMs + 5000, "browser server launch"); }
    catch (error) { abandoned = true; throw error; }
    const child = server.process();
    if (!child?.pid) throw new Error("Browser server did not identify its owned process");
    tracker = (dependencies.trackerFactory ?? createProcessTracker)(child.pid);
    await tracker.sample();
    browser = await bounded(
      () => chromium.connect(server.wsEndpoint(), { timeout: 15000 }), 20000, "browser connect",
    );
    return {
      browser, pid: child.pid,
      transport: cleanup.transport,
      sample: () => tracker.sample(),
      close: finish,
    };
  } catch (error) {
    await finish();
    const failure = new Error("Audit browser launch failed");
    failure.auditError = safeError(error, "launch");
    failure.cleanup = cleanup;
    throw failure;
  }
}

export async function inspectSandbox(browser) {
  const context = await browser.newContext({ viewport: null });
  try {
    const page = await context.newPage();
    await page.goto("chrome://sandbox", { timeout: 10000 });
    const text = await page.locator("body").innerText({ timeout: 5000 });
    if (/not adequately sandboxed|sandbox(?:ing)? (?:is )?disabled|no sandbox/i.test(text))
      return { status: "rejected", configured: true };
    return {
      status: /You are adequately sandboxed\./i.test(text) ? "confirmed" : "unavailable",
      configured: true,
    };
  } catch {
    return { status: "unavailable", configured: true, reason: "Internal sandbox page could not be evaluated." };
  } finally { await bounded(() => context.close(), 10000, "sandbox context close"); }
}
