import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchEnvironment, cleanupLaunchEnvironment, validateOutput, environmentReceipt, observeEnvironment, displayKeys } from "./environment.mjs";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
async function temporary(work) {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-environment-");
  try { return await work(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const settings = { id: "controlled", locale: "en-US", timezoneId: "UTC" };

test("headless uses explicit private paths and never inherits endpoints or credentials", async () => temporary(async root => {
  const env = await launchEnvironment(settings, root, "headless");
  for (const key of [...displayKeys, "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "LICENSE_KEY", "DEBUG"])
    assert.equal(Object.hasOwn(env, key), false);
  assert.ok(env.HOME.startsWith(root));
  assert.equal((await fs.stat(env.HOME)).mode & 0o777, 0o700);
  const receipt = await environmentReceipt(settings, env);
  assert.equal(receipt.display.xRequired, false);
  assert.ok(!JSON.stringify(receipt).includes(env.HOME));
  assert.ok(env.TMPDIR.length < 40);
  assert.equal((await cleanupLaunchEnvironment(env, { resourcesClosed: true })).rootRemoved, true);
}));

test("headed refuses an ambient or unauthenticated display", async () => temporary(async root => {
  await assert.rejects(launchEnvironment(settings, root, "headed"), /verified/);
  await assert.rejects(launchEnvironment(settings, root, "headed", { display: ":1", owned: true }), /verified/);
  const env = await launchEnvironment(settings, root, "headed", {
    display: ":99", owned: true, authEnforced: true, xauthorityPath: path.join(root, "auth"),
  });
  assert.equal(env.DISPLAY, ":99");
  assert.equal(Object.hasOwn(env, "WAYLAND_DISPLAY"), false);
  await cleanupLaunchEnvironment(env, { resourcesClosed: true });
}));

test("runtime roots are retained until browser cleanup is verified", async () => temporary(async root => {
  const env = await launchEnvironment(settings, root, "headless");
  assert.equal((await cleanupLaunchEnvironment(env)).retained, true);
  const directory = path.dirname(env.TMPDIR);
  assert.equal((await fs.stat(directory)).isDirectory(), true);
  await cleanupLaunchEnvironment(env, { resourcesClosed: true });
  assert.equal(await fs.stat(directory).then(() => true, () => false), false);
}));

test("private reports cannot live inside the public checkout or under a symlink", async () => temporary(async root => {
  await assert.rejects(validateOutput(projectRoot, projectRoot), /outside/);
  await fs.symlink(root, path.join(root, "alias"));
  await assert.rejects(validateOutput(path.join(root, "alias", "new"), projectRoot), /ancestry/);
  assert.equal(await validateOutput(path.join(root, "new"), projectRoot), path.join(root, "new"));
}));

test("environment metadata does not require a deliberately refused proxy route to work", async () => {
  let closed = false;
  const browser = {
    newContext: async () => ({
      newPage: async () => ({
        url: () => "about:blank",
        goto: async () => { throw new Error("A network navigation was attempted"); },
        evaluate: async () => ({ language: "en-US", screen: { width: 1920, height: 1080 } }),
      }),
      close: async () => { closed = true; },
    }),
  };
  const result = await observeEnvironment(browser, "http://127.0.0.1:1", {});
  assert.equal(result.samplingScope, "network-independent-about-blank");
  assert.equal(result.language, "en-US");
  assert.equal(closed, true);
});

test("actual context policy changes are part of the configuration receipt", async () => temporary(async root => {
  const env = await launchEnvironment(settings, root, "headless");
  try {
    const first = await environmentReceipt(settings, env, null, null, { locale: "en-US" });
    const second = await environmentReceipt(settings, env, null, null, { locale: "de-DE" });
    assert.notEqual(first.configSha256, second.configSha256);
  } finally { await cleanupLaunchEnvironment(env, { resourcesClosed: true }); }
}));
