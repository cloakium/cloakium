/**
 * Coverage and parity: newly humanized methods, untouched native surfaces, and
 * Playwright's strictness rules through the wrappers.
 */

import assert from "node:assert/strict";

import { browserAvailable } from "../browser/browser-env.mjs";
import { skip, test } from "../browser/harness.mjs";
import { openSession } from "./session.mjs";

function contract(name, fn) {
  if (browserAvailable) test(name, fn);
  else skip(name, "no Chromium binary configured (set CLOAKIUM_BINARY_PATH)");
}

const DETERMINISTIC = { random: () => 0.5, mistakeChance: 0 };

contract("pressSequentially types with human key timing", async () => {
  const session = await openSession({
    humanConfig: { ...DETERMINISTIC, keyGap: [120, 120], keyHold: [20, 20] },
  });
  try {
    const started = Date.now();
    await session.page.locator("#input").pressSequentially("abc", { timeout: 10_000 });
    const elapsed = Date.now() - started;

    assert.equal(await session.page.locator("#input").inputValue(), "abc");
    assert.ok(elapsed >= 400, `pressSequentially must use human gaps, took ${elapsed}ms`);

    const log = await session.page.evaluate(() => window.log);
    assert.ok(log.keydowns >= 3, `expected key events, saw ${log.keydowns}`);
    assert.equal(log.trustedKeys, log.keydowns);
  } finally {
    await session.close();
  }
});

contract("tap moves the pointer and emits a trusted touch gesture", async () => {
  const session = await openSession({ contextOptions: { hasTouch: true } });
  try {
    await session.page.locator("#btn").tap({ timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.touches, 1, "one touchstart");
    assert.equal(log.trustedTouches, 1, "the touch must be browser-generated");
    assert.ok(log.mouseMoves >= 4, `expected a pointer path, saw ${log.mouseMoves} moves`);
    assert.equal(log.clicks, 1, "a tap clicks the button once");

    // Selector form shares the action but reads its options from index 1.
    await session.page.tap("#btn", { timeout: 5_000 });
    assert.equal(await session.page.evaluate(() => window.log.touches), 2);
  } finally {
    await session.close();
  }
});

contract("clear empties a field with real key events", async () => {
  const session = await openSession();
  try {
    const input = session.page.locator("#input");
    await input.fill("abc", { timeout: 5_000 });
    const before = await session.page.evaluate(() => window.log.keydowns);
    await input.clear({ timeout: 5_000 });

    assert.equal(await input.inputValue(), "");
    const after = await session.page.evaluate(() => window.log.keydowns);
    assert.ok(after > before, "clear must select and delete, not set the value directly");
  } finally {
    await session.close();
  }
});

contract("fill on a non-editable element fails clearly", async () => {
  const session = await openSession();
  try {
    // A disabled field is editable-typed but not editable: the wrapper's own error.
    await assert.rejects(
      () => session.page.locator("#disabled").fill("nope", { timeout: 3_000 }),
      (error) => error.name === "HumanizeError" && /not editable/.test(error.message),
    );

    // A non-form element keeps Playwright's own diagnostic.
    await assert.rejects(
      () => session.page.locator("#btn").fill("nope", { timeout: 3_000 }),
      (error) => /not an <input>/.test(error.message),
    );
  } finally {
    await session.close();
  }
});

contract("check and uncheck click the box and verify the state", async () => {
  const session = await openSession();
  try {
    const box = session.page.locator("#agree");
    await box.check({ timeout: 5_000 });
    assert.equal(await box.isChecked(), true);
    await box.uncheck({ timeout: 5_000 });
    assert.equal(await box.isChecked(), false);

    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.checks, 2);
    assert.ok(log.mouseMoves >= 4, `expected pointer movement, saw ${log.mouseMoves}`);
  } finally {
    await session.close();
  }
});

contract("force skips the wait but not the need for a visible box", async () => {
  const session = await openSession();
  try {
    const started = Date.now();
    await assert.rejects(
      () => session.page.locator("#hidden").click({ force: true, timeout: 5_000 }),
      (error) => error.name === "HumanizeError" && /no visible box/.test(error.message),
    );
    assert.ok(Date.now() - started < 1_500, "force must not wait for a hidden element");
  } finally {
    await session.close();
  }
});

contract("strict locator semantics survive the wrapper", async () => {
  const session = await openSession();
  try {
    await assert.rejects(
      () => session.page.locator(".dup").click({ timeout: 3_000 }),
      (error) => /strict mode violation/.test(error.message),
    );
    assert.equal(
      await session.page.evaluate(() => window.log.dupClicks),
      0,
      "a strict violation must not click anything",
    );

    await session.page.click(".dup", { timeout: 3_000 });
    assert.equal(await session.page.evaluate(() => window.log.dupClicks), 1);
  } finally {
    await session.close();
  }
});

contract("ElementHandle actions stay native, as documented", async () => {
  const session = await openSession();
  try {
    const handle = await session.page.locator("#btn").elementHandle();
    await handle.click({ timeout: 5_000 });
    const log = await session.page.evaluate(() => window.log);
    assert.equal(log.clicks, 1);
    assert.equal(log.trustedClicks, 1);
    assert.ok(
      log.mouseMoves <= 2,
      `ElementHandle is not humanized; expected no pointer path, saw ${log.mouseMoves} moves`,
    );
  } finally {
    await session.close();
  }
});
