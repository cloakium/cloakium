/**
 * Re-patching must reconfigure future targets, not only the pages that already
 * exist when `patchPage`/`patchContext`/`patchBrowser` is called.
 */

import assert from "node:assert/strict";

import { launch } from "../../dist/index.js";
import { patchBrowser, patchContext, patchPage, resolveConfig } from "../../dist/human/index.js";
import { browserAvailable, sandboxArgs } from "../browser/browser-env.mjs";
import { skip, test } from "../browser/harness.mjs";
import { fixtureUrl } from "./session.mjs";

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

const DETERMINISTIC = { random: () => 0.5, mistakeChance: 0 };
const FAST = resolveConfig("default", { ...DETERMINISTIC, pathPoints: 2 });
const LONG = resolveConfig("default", { ...DETERMINISTIC, pathPoints: 24 });

async function openBrowser() {
  const browser = await launch({
    headless: true,
    args: sandboxArgs(),
    launchOptions: { timeout: 60_000 },
  });
  return {
    browser,
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}

async function clickAndMeasure(page, selector = "#btn") {
  await page.locator(selector).click({ timeout: 5_000 });
  return page.evaluate(() => window.log);
}

contract("re-patching a browser reconfigures future contexts and pages", async () => {
  const { browser, close } = await openBrowser();
  try {
    patchBrowser(browser, FAST);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(await fixtureUrl());

    const fast = await clickAndMeasure(page);
    assert.ok(fast.mouseMoves <= 6, `expected the fast path, saw ${fast.mouseMoves} moves`);

    patchBrowser(browser, LONG);

    // A different element on the same page: the pointer starts where the last
    // click left it, so re-clicking the same button would not move at all.
    const patched = await clickAndMeasure(page, "#dup-a");
    assert.ok(
      patched.mouseMoves - fast.mouseMoves >= 12,
      `the existing page must adopt the new config, saw ${patched.mouseMoves - fast.mouseMoves} more moves`,
    );

    const contextPage = await context.newPage();
    await contextPage.goto(await fixtureUrl());
    const fromContext = await clickAndMeasure(contextPage);
    assert.ok(
      fromContext.mouseMoves >= 12,
      `a new page of an already-patched context must use the new config, saw ${fromContext.mouseMoves} moves`,
    );

    const browserPage = await browser.newPage();
    await browserPage.goto(await fixtureUrl());
    const fromBrowserPage = await clickAndMeasure(browserPage);
    assert.ok(
      fromBrowserPage.mouseMoves >= 12,
      `browser.newPage must use the new config, saw ${fromBrowserPage.mouseMoves} moves`,
    );

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(await fixtureUrl());
    const fromBrowserContext = await clickAndMeasure(freshPage);
    assert.ok(
      fromBrowserContext.mouseMoves >= 12,
      `browser.newContext must use the new config, saw ${fromBrowserContext.mouseMoves} moves`,
    );
    assert.equal(fromBrowserContext.clicks, 1, "one click, one wrapper");
    assert.equal(fromBrowserContext.trustedClicks, 1);
  } finally {
    await close();
  }
});

contract("re-patching a context reconfigures its future pages", async () => {
  const { browser, close } = await openBrowser();
  try {
    const context = await browser.newContext();
    patchContext(context, FAST);
    const page = await context.newPage();
    await page.goto(await fixtureUrl());
    const fast = await clickAndMeasure(page);
    assert.ok(fast.mouseMoves <= 6, `expected the fast path, saw ${fast.mouseMoves} moves`);

    patchContext(context, LONG);
    const next = await context.newPage();
    await next.goto(await fixtureUrl());
    const reconfigured = await clickAndMeasure(next);
    assert.ok(
      reconfigured.mouseMoves >= 12,
      `a future context page must use the new config, saw ${reconfigured.mouseMoves} moves`,
    );
  } finally {
    await close();
  }
});

contract("re-patching one page changes its config without stacking wrappers", async () => {
  const { browser, close } = await openBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(await fixtureUrl());
    patchPage(page, FAST);

    const fast = await clickAndMeasure(page);
    assert.ok(fast.mouseMoves <= 6, `expected the fast path, saw ${fast.mouseMoves} moves`);

    patchPage(page, LONG);
    const reconfigured = await clickAndMeasure(page, "#dup-a");
    assert.ok(
      reconfigured.mouseMoves - fast.mouseMoves >= 12,
      `patchPage must adopt the new config, saw ${reconfigured.mouseMoves} moves`,
    );
    assert.equal(reconfigured.dupClicks, 1, "the second click landed once");
    assert.equal(reconfigured.clicks, 1, "one wrapper, one click event per button");
  } finally {
    await close();
  }
});
