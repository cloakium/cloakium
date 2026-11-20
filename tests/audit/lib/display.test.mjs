import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createDisplayManager, displayArguments, verifiedDisplay } from "./display.mjs";
import { jsonCommand } from "./commands.mjs";

const settings = { kind: "managed", width: 1920, height: 1080, depth: 24, dpi: 96, windowManager: "none" };
async function temporary(work) {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-display-node-");
  try { return await work(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("headless never starts or inspects an X display", async () => {
  const manager = createDisplayManager({ settings, output: "/not-used" }, {
    command: () => { throw new Error("X was touched"); },
  });
  assert.equal(await manager.get("headless"), null);
  assert.equal((await manager.close()).closed, true);
});

test("managed display starts once, matches the plan, and records cleanup", async () => temporary(async output => {
  const calls = [];
  const manager = createDisplayManager({ settings, output, helper: "/fixture/helper" }, {
    command: async (_exe, args) => {
      calls.push(args[0]);
      return args[0] === "stop" ? { stopped: true, stateRemoved: true, socketRemoved: true } : {};
    },
    verify: async () => ({ owned: true, screen: settings, windowManager: "none" }),
  });
  await manager.get("headed");
  await manager.get("headed");
  assert.equal((await manager.close()).closed, true);
  assert.equal((await manager.close()).closed, true);
  assert.deepEqual(calls, ["start", "stop"]);
}));

test("display placeholders cannot leak into headless or adopt ambient values", () => {
  assert.throws(() => displayArguments(["--display={display.display}"], "headless", null), /owned/);
  const display = { owned: true, display: ":99", xauthorityPath: "/private/Xauthority", stateDir: "/private" };
  assert.deepEqual(displayArguments(["--display={display.display}"], "headed", display), ["--display=:99"]);
  assert.throws(() => displayArguments(["{display.unknown}"], "headed", display), /Unknown/);
});

test("display verification checks live process identity in addition to a state file", async () => temporary(async root => {
  await fs.writeFile(path.join(root, "display.json"), JSON.stringify({
    schema: "cloakium.audit.display/1", owned: true, authEnforced: true,
    display: ":99", xvfbPid: 100, xauthorityPath: path.join(root, "Xauthority"),
  }), { mode: 0o600 });
  await assert.rejects(verifiedDisplay("/fixture/helper", root, async () => ({
    xvfbAlive: false, wmAlive: true, socketOwned: true, reachable: true,
  })), /not live/);
}));

test("helper protocol omits raw stderr and bounds stalled commands", async () => {
  const result = await jsonCommand(process.execPath, ["-e", "console.log(JSON.stringify({ok:true}))"], { timeoutMs: 3000 });
  assert.deepEqual(result, { ok: true });
  await assert.rejects(jsonCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 25 }),
    { code: "AUDIT_DEADLINE" });
  await assert.rejects(jsonCommand(process.execPath, ["-e", "console.error('fixture-private');process.exit(1)"]),
    error => !error.message.includes("fixture-private"));
});
