/**
 * One action budget per public call: an explicit `timeout` covers the focus
 * click, the pauses and the typing together. `0` disables the budget and an
 * omitted timeout inherits Playwright's page default.
 */

import assert from "node:assert/strict";

import { browserAvailable } from "../browser/browser-env.mjs";
import { skip, test } from "../browser/harness.mjs";
import { openSession } from "./session.mjs";

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

const SLOW = {
  random: () => 0.5,
  mistakeChance: 0,
  pathPoints: 14,
  pressPause: [800, 800],
  holdTime: [800, 800],
  focusPause: [800, 800],
  keyGap: [800, 800],
  keyHold: [800, 800],
};

async function timed(run) {
  const started = Date.now();
  const error = await run().then(
    () => null,
    (failure) => failure,
  );
  return { error, elapsed: Date.now() - started };
}

function expectTimeout(error, api) {
  assert.ok(error !== null, `expected ${api} to time out`);
  assert.equal(error.name, "TimeoutError", error.message);
  assert.match(error.message, new RegExp(api), error.message);
}

contract("fill spends one budget across focus, clearing and typing", async () => {
  const session = await openSession({ humanConfig: SLOW });
  try {
    const { error, elapsed } = await timed(() =>
      session.page.locator("#input").fill("abcdef", { timeout: 600 }),
    );
    expectTimeout(error, "fill");
    assert.ok(elapsed < 1_500, `fill must stop near its budget, took ${elapsed}ms`);
    assert.equal(await session.page.locator("#input").inputValue(), "");
  } finally {
    await session.close();
  }
});

contract("type and press share the same budget", async () => {
  const session = await openSession({ humanConfig: SLOW });
  try {
    const typed = await timed(() =>
      session.page.locator("#input").type("abc", { timeout: 500 }),
    );
    expectTimeout(typed.error, "type");
    assert.ok(typed.elapsed < 1_500, `type must stop near its budget, took ${typed.elapsed}ms`);

    const pressed = await timed(() =>
      session.page.locator("#btn").press("Enter", { timeout: 500 }),
    );
    expectTimeout(pressed.error, "press");
    assert.ok(pressed.elapsed < 1_500, `press must stop near its budget, took ${pressed.elapsed}ms`);
  } finally {
    await session.close();
  }
});

contract("timeout: 0 disables the budget", async () => {
  const session = await openSession();
  try {
    await session.page.locator("#btn").click({ timeout: 0 });
    assert.equal(await session.page.evaluate(() => window.log.clicks), 1);
  } finally {
    await session.close();
  }
});

contract("an omitted timeout inherits Playwright's page default", async () => {
  const session = await openSession();
  try {
    await session.page.setDefaultTimeout(300);
    const { error, elapsed } = await timed(() => session.page.locator("#missing").click());
    assert.ok(error !== null, "a missing element must time out");
    assert.equal(error.name, "TimeoutError");
    assert.ok(elapsed >= 200, `the page default must be honoured, took only ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `the wrapper must not wait for its own 30s default, took ${elapsed}ms`);
  } finally {
    await session.close();
  }
});
