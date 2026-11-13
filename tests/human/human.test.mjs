/**
 * Humanize behaviour against the localhost fixture.
 *
 * These tests assert observable page behaviour (trusted input events, pointer
 * movement, wheel notches, scrolling) rather than implementation details.
 */

import assert from "node:assert/strict";

import { HumanizeCoveredError, launch } from "../../dist/index.js";
import { patchBrowser, patchPage, resolveConfig } from "../../dist/human/index.js";
import { browserAvailable, sandboxArgs } from "../browser/browser-env.mjs";
import { skip, test } from "../browser/harness.mjs";
import { startFixture } from "./fixture.mjs";

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

const DETERMINISTIC = { random: () => 0.5, mistakeChance: 0 };

let fixture;

async function openPage({ humanize = true } = {}) {
  fixture ??= await startFixture();
  const browser = await launch({
    headless: true,
    humanize,
    humanConfig: DETERMINISTIC,
    args: sandboxArgs(),
    launchOptions: { timeout: 60_000 },
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixture.url);
  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

contract("locator click moves the pointer and produces a trusted click", async () => {
  const session = await openPage();
  try {
    await session.page.locator("#btn").click({ timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.clicks, 1);
    assert.equal(log.trustedClicks, 1, "click must be a trusted browser event");
    assert.ok(log.mouseMoves >= 4, `expected a pointer path, saw ${log.mouseMoves} moves`);
    assert.equal(await session.page.locator("#out").textContent(), "1");
  } finally {
    await session.close();
  }
});

contract("selector-based page.click uses the first match", async () => {
  const session = await openPage();
  try {
    await session.page.click("#btn", { timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.clicks, 1);
    assert.equal(log.trustedClicks, 1);
  } finally {
    await session.close();
  }
});

contract("fill, pressSequentially and keyboard.type type into the field", async () => {
  const session = await openPage();
  try {
    const input = session.page.locator("#input");
    await input.fill("hello", { timeout: 5_000 });
    assert.equal(await input.inputValue(), "hello");

    await input.pressSequentially("!", { timeout: 5_000 });
    assert.equal(await input.inputValue(), "hello!");

    await input.click({ timeout: 5_000 });
    await session.page.keyboard.type("ok", { timeout: 5_000 });
    assert.equal(await input.inputValue(), "hello!ok");

    const log = await session.page.evaluate(() => window.log);
    assert.ok(log.keydowns > 0, "typing must produce key events");
    assert.equal(log.trustedKeys, log.keydowns, "every key event must be trusted");
  } finally {
    await session.close();
  }
});

contract("iframe controls are clickable through frameLocator and frame.click", async () => {
  const session = await openPage();
  try {
    const inner = session.page.frameLocator("#frame").locator("#inner-btn");
    await inner.click({ timeout: 5_000 });

    const innerFrame = session.page.frames().find((frame) => frame !== session.page.mainFrame());
    assert.ok(innerFrame !== undefined, "fixture iframe must be attached");
    await innerFrame.click("#inner-btn", { timeout: 5_000 });

    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.innerClicks, 2);
  } finally {
    await session.close();
  }
});

contract("an off-screen control is reached with wheel notches", async () => {
  const session = await openPage();
  try {
    await session.page.locator("#deep").click({ timeout: 15_000 });
    const result = await session.page.evaluate(() => ({
      log: window.log,
      scrollY: window.scrollY,
    }));
    assert.equal(result.log.deepClicks, 1);
    assert.ok(result.scrollY > 500, `expected scrolling, got ${result.scrollY}`);
    assert.ok(result.log.wheels.length > 0, "expected wheel events");
    for (const event of result.log.wheels) {
      assert.equal(event.trusted, true, "wheel events must be trusted");
      assert.equal(Math.abs(event.dy), 100, `wheel notch should be 100px, got ${event.dy}`);
    }
  } finally {
    await session.close();
  }
});

contract("a covered element fails clearly, and force skips the check", async () => {
  const session = await openPage();
  try {
    await assert.rejects(
      () => session.page.locator("#covered").click({ timeout: 3_000 }),
      HumanizeCoveredError,
    );
    await session.page.locator("#covered").click({ force: true, timeout: 3_000 });
  } finally {
    await session.close();
  }
});

contract("a missing element fails with Playwright's TimeoutError", async () => {
  const session = await openPage();
  try {
    await assert.rejects(
      () => session.page.locator("#missing").click({ timeout: 400 }),
      (error) => error.name === "TimeoutError",
    );
  } finally {
    await session.close();
  }
});

contract("humanize is opt-in: an unpatched browser stays native", async () => {
  const session = await openPage({ humanize: false });
  try {
    await session.page.click("#btn", { timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.clicks, 1);
    assert.ok(log.mouseMoves <= 1, `native click should not curve, saw ${log.mouseMoves}`);
  } finally {
    await session.close();
  }
});

contract("patching twice keeps one wrapper", async () => {
  const session = await openPage();
  try {
    const config = resolveConfig("default", DETERMINISTIC);
    patchBrowser(session.browser, config);
    patchBrowser(session.browser, config);
    patchPage(session.page, config);
    patchPage(session.page, config);

    await session.page.locator("#btn").click({ timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.clicks, 1, "one click must produce exactly one click event");
  } finally {
    await session.close();
  }
});