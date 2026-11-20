import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { loadDriver } from "./hashes.mjs";
import { launchBrowser, inspectSandbox } from "./browser.mjs";
import { launchEnvironment, cleanupLaunchEnvironment, observeEnvironment } from "./environment.mjs";
import { startOrigin } from "../network/lab/origin.mjs";

test("selected unlicensed browser supports long evidence paths and leaves no tracked process", {
  skip: !process.env.CLOAKIUM_AUDIT_TEST_BINARY || !process.env.CLOAKIUM_AUDIT_TEST_CLIENT,
  timeout: 120000,
}, async () => {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-browser-integration-");
  let lab;
  let session;
  let env;
  try {
    const environment = { id: "integration", locale: "en-US", timezoneId: "UTC",
      fontconfigFile: process.env.CLOAKIUM_AUDIT_TEST_FONTCONFIG };
    const directory = path.join(root, "long-configuration-path-".repeat(6));
    env = await launchEnvironment(environment, directory, "headless");
    assert.ok(directory.length > 150);
    assert.ok(env.TMPDIR.length < 40);
    const driver = await loadDriver(process.env.CLOAKIUM_AUDIT_TEST_CLIENT);
    lab = await startOrigin();
    session = await launchBrowser({
      chromium: driver.chromium, executablePath: process.env.CLOAKIUM_AUDIT_TEST_BINARY,
      mode: "headless", args: ["--fingerprint=42424", "--window-size=1280,800"], env,
      ignoreDefaultArgs: ["--hide-scrollbars", "--mute-audio",
        "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"],
    });
    assert.equal(typeof session.browser.version(), "string");
    const sandbox = await inspectSandbox(session.browser);
    assert.notEqual(sandbox.status, "rejected");
    const observed = await observeEnvironment(session.browser, lab.origin, {
      locale: environment.locale, timezoneId: environment.timezoneId,
    });
    assert.equal(observed.intl.timeZone, "UTC");
    assert.equal(observed.language, "en-US");
    await session.sample();
    const cleanup = await session.close();
    assert.equal(cleanup.closed, true, JSON.stringify(cleanup));
    assert.deepEqual(cleanup.remaining, []);
  } finally {
    const cleanup = session ? await session.close() : { closed: true };
    if (lab) await lab.close();
    if (env) await cleanupLaunchEnvironment(env, { resourcesClosed: cleanup.closed });
    await fs.rm(root, { recursive: true, force: true });
  }
});
