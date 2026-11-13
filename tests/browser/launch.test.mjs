// Real-browser launch contracts; skipped when no executable is configured.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  launch,
  launchContext,
  launchPersistentContext,
  SEED_FILE,
} from "../../dist/index.js";
import { browserAvailable, sandboxArgs } from "./browser-env.mjs";
import { skip, test } from "./harness.mjs";

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

const LAUNCH_OPTIONS = { timeout: 60_000 };

contract("the default browser enables namespace and seccomp sandboxing", async () => {
  const browser = await launch({ headless: true, launchOptions: { timeout: 10_000 } });
  try {
    const page = await browser.newPage();
    await page.goto("chrome://sandbox");
    const status = await page.locator("body").innerText();
    assert.match(status, /PID namespaces\s+Yes/i);
    assert.match(status, /Network namespaces\s+Yes/i);
    assert.match(status, /Seccomp-BPF sandbox\s+Yes/i);
  } finally {
    await browser.close();
  }
});

async function withBrowser(fn, options = {}) {
  const browser = await launch({
    headless: true,
    args: sandboxArgs(),
    launchOptions: LAUNCH_OPTIONS,
    ...options,
  });
  try {
    await fn(browser);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

contract("launch returns a Playwright browser with viewport:null by default", async () => {
  await withBrowser(async (browser) => {
    assert.equal(typeof browser.newContext, "function");
    const context = await browser.newContext();
    const page = await context.newPage();
    assert.equal(page.viewportSize(), null);
    assert.equal(await page.evaluate(() => 1 + 1), 2);
    await context.close();
  });
});

contract("an explicit viewport is honoured", async () => {
  await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    assert.deepEqual(page.viewportSize(), { width: 800, height: 600 });
    await context.close();
  });
});

contract("locale is applied as a Playwright context default", async () => {
  await withBrowser(
    async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const language = await page.evaluate(() => navigator.language);
      assert.ok(language.toLowerCase().startsWith("de"), `got ${language}`);
      await context.close();
    },
    { locale: "de-DE" },
  );
});

contract("launchContext closes the browser with the context", async () => {
  const context = await launchContext({
    headless: true,
    args: sandboxArgs(),
    launchOptions: LAUNCH_OPTIONS,
  });
  const browser = context.browser();
  assert.ok(browser !== null);
  const page = await context.newPage();
  assert.equal(page.viewportSize(), null);
  await context.close();
  assert.equal(browser.isConnected(), false);
});

contract("persistent context keeps viewport:null and a stable seed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-profile-"));
  const first = await launchPersistentContext({
    userDataDir: directory,
    headless: true,
    args: sandboxArgs(),
    launchOptions: LAUNCH_OPTIONS,
  });
  const firstPage = first.pages()[0];
  assert.ok(firstPage !== undefined, "persistent context starts with a page");
  assert.equal(firstPage.viewportSize(), null);
  await first.close();

  const seedPath = path.join(directory, SEED_FILE);
  assert.equal(fs.existsSync(seedPath), true);
  const seed = fs.readFileSync(seedPath, "utf8").trim();
  assert.match(seed, /^\d{5}$/);

  const second = await launchPersistentContext({
    userDataDir: directory,
    headless: true,
    args: sandboxArgs(),
    launchOptions: LAUNCH_OPTIONS,
  });
  await second.close();
  assert.equal(fs.readFileSync(seedPath, "utf8").trim(), seed);
});

contract("persistent context options win over forwarded launch options", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-profile-viewport-"));
  const context = await launchPersistentContext({
    userDataDir: directory,
    headless: true,
    viewport: { width: 900, height: 700 },
    args: sandboxArgs(),
    launchOptions: { ...LAUNCH_OPTIONS, viewport: { width: 320, height: 200 } },
  });
  try {
    const page = context.pages()[0];
    assert.deepEqual(page.viewportSize(), { width: 900, height: 700 });
  } finally {
    await context.close();
  }
});

contract("a legacy profile seed is reused without writing a new file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloakium-profile-legacy-"));
  fs.writeFileSync(path.join(directory, ".cloakbrowser-seed"), "32100\n");
  const context = await launchPersistentContext({
    userDataDir: directory,
    headless: true,
    args: sandboxArgs(),
    launchOptions: LAUNCH_OPTIONS,
  });
  await context.close();
  assert.equal(fs.existsSync(path.join(directory, SEED_FILE)), false);
  assert.equal(fs.readFileSync(path.join(directory, ".cloakbrowser-seed"), "utf8").trim(), "32100");
});

contract("geoipResolver supplies context timezone and locale", async () => {
  await withBrowser(
    async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      assert.equal(timezone, "Europe/Berlin");
      const language = await page.evaluate(() => navigator.language);
      assert.ok(language.toLowerCase().startsWith("de"), `got ${language}`);
      await context.close();
    },
    {
      geoip: true,
      geoipResolver: () => ({ timezone: "Europe/Berlin", locale: "de-DE" }),
    },
  );
});
