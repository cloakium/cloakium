import test from "node:test";
import assert from "node:assert/strict";
import { createChildLease, createProcessTracker } from "./processes.mjs";
import { assertSandboxArguments, launchBrowser, inspectSandbox } from "./browser.mjs";

test("process tracking follows only descendants and never signals a reused pid", async () => {
  const instances = new Map([
    [100, { pid: 100, startTicks: "a", state: "S" }],
    [101, { pid: 101, startTicks: "b", state: "S" }],
  ]);
  const signals = [];
  const tracker = createProcessTracker(100, {
    inspect: async pid => instances.get(pid) ?? null,
    children: async pid => ({ pids: pid === 100 ? [101] : [], errors: [] }),
    signal: (pid, name) => signals.push({ pid, name }),
  });
  assert.equal((await tracker.sample()).identities.length, 2);
  instances.set(101, { pid: 101, startTicks: "replacement", state: "S" });
  await tracker.terminate("SIGTERM");
  assert.deepEqual(signals, [{ pid: 100, name: "SIGTERM" }]);
  instances.delete(100);
  assert.deepEqual(await tracker.remaining(), []);
});

test("unreadable owned process state is unknown, not silently clean", async () => {
  let denied = false;
  const tracker = createProcessTracker(100, {
    inspect: async () => { if (denied) throw new Error("denied"); return { pid: 100, startTicks: "a", state: "S" }; },
    children: async () => ({ pids: [], errors: [] }),
  });
  await tracker.sample();
  denied = true;
  assert.equal((await tracker.remaining())[0].verification, "unverified");
});

test("resampling a reused root never adopts the replacement or its descendants", async () => {
  let instance = "original";
  const signals = [];
  const tracker = createProcessTracker(100, {
    inspect: async pid => ({ pid, startTicks: instance, state: "S" }),
    children: async pid => ({ pids: instance === "replacement" && pid === 100 ? [999] : [], errors: [] }),
    signal: pid => signals.push(pid),
  });
  await tracker.sample();
  instance = "replacement";
  assert.equal((await tracker.sample()).identities.length, 1);
  await tracker.terminate("SIGKILL");
  assert.deepEqual(signals, []);
});

test("a child lease never signals its parent or fixtures that existed before launch", async () => {
  const instances = new Map([
    [100, { pid: 100, startTicks: "parent", state: "S" }],
    [101, { pid: 101, startTicks: "fixture", state: "S" }],
  ]);
  const signals = [];
  const lease = await createChildLease(100, {
    inspect: async pid => instances.get(pid) ?? null,
    children: async pid => ({ pids: pid === 100 ? [...instances.keys()].filter(value => value !== 100) : [], errors: [] }),
    signal: pid => signals.push(pid),
  });
  instances.set(102, { pid: 102, startTicks: "browser", state: "S" });
  assert.equal((await lease.sample()).identities.length, 1);
  await lease.terminate("SIGTERM");
  assert.deepEqual(signals, [102]);
});

test("an unverified first root is never adopted later as a possibly reused pid", async () => {
  let visible = false;
  const tracker = createProcessTracker(100, {
    inspect: async pid => visible ? { pid, startTicks: "replacement", state: "S" } : null,
    children: async () => ({ pids: [], errors: [] }),
  });
  assert.ok((await tracker.sample()).limitations.length > 0);
  visible = true;
  assert.deepEqual((await tracker.sample()).identities, []);
});

function fakeDriver({ stallClose = false, failConnect = false } = {}) {
  const calls = [];
  const child = { pid: 100, exitCode: null, signalCode: null };
  const server = {
    process: () => child,
    wsEndpoint: () => "ws://127.0.0.1/private-fixture-only",
    close: async () => { calls.push("server.close"); if (stallClose) return new Promise(() => {}); child.exitCode = 0; },
    kill: async () => { calls.push("server.kill"); child.signalCode = "SIGKILL"; },
  };
  return {
    calls, child,
    chromium: {
      launchServer: async options => {
        assert.equal(options.chromiumSandbox, true);
        assert.equal(options.host, "127.0.0.1");
        assert.equal(options.port, 0);
        calls.push("launch");
        return server;
      },
      connect: async () => {
        if (failConnect) throw new Error("fixture-only failure");
        return { close: async () => calls.push("browser.close") };
      },
    },
  };
}

const trackerFactory = () => ({
  sample: async () => ({}), waitGone: async () => [], limitations: [],
});
const launchOptions = fake => ({
  chromium: fake.chromium, executablePath: "/fixture/browser",
  mode: "headless", args: [], env: {}, cleanupMs: 10,
});

test("browser lifecycle uses public server process and closes exactly once", async () => {
  const fake = fakeDriver();
  const session = await launchBrowser(launchOptions(fake), { trackerFactory });
  const [a, b] = await Promise.all([session.close(), session.close()]);
  assert.equal(a.closed, true);
  assert.equal(a, b);
  assert.deepEqual(fake.calls, ["launch", "browser.close", "server.close"]);
});

test("a stalled graceful close is forcibly terminated and recorded", async () => {
  const fake = fakeDriver({ stallClose: true });
  const session = await launchBrowser(launchOptions(fake), { trackerFactory });
  const result = await session.close();
  assert.equal(result.forced, true);
  assert.equal(result.rootExited, true);
  assert.ok(fake.calls.includes("server.kill"));
});

test("connection failure still closes the owned server", async () => {
  const fake = fakeDriver({ failConnect: true });
  await assert.rejects(launchBrowser(launchOptions(fake), { trackerFactory }), error => error.cleanup.closed);
  assert.ok(fake.calls.includes("server.close"));
});

test("sandbox-weakening arguments and headless display inheritance are refused", async () => {
  for (const arg of ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security",
    "--disable-gpu-sandbox", "--disable-seccomp-filter-sandbox", "--single-process",
    "--no-zygote", "--disable-features=NetworkServiceSandbox"])
    assert.throws(() => assertSandboxArguments([arg]));
  const fake = fakeDriver();
  await assert.rejects(launchBrowser({ ...launchOptions(fake), env: { DISPLAY: ":1" } }), /display/);
});

test("a negative sandbox sentence cannot match the positive substring", async () => {
  const browser = {
    newContext: async () => ({
      newPage: async () => ({ goto: async () => {}, locator: () => ({ innerText: async () => "You are NOT adequately sandboxed." }) }),
      close: async () => {},
    }),
  };
  assert.equal((await inspectSandbox(browser)).status, "rejected");
});
