// Persistent-context regression fixtures for the Cloakium patched driver.
//
// launchPersistentContext is the one startup path that also waits for the
// default page's "load" lifecycle, so it catches context-initialisation
// regressions that a plain launch() cannot see. Every operation is bounded to
// 5s: a regression fails fast instead of stalling the whole suite.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPERATION_TIMEOUT_MS = 5_000;

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not settle within ${OPERATION_TIMEOUT_MS}ms`)),
        OPERATION_TIMEOUT_MS,
      );
    }),
  ]);
}

function profileDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `cloakium-driver-${prefix}-`));
  return directory;
}

/**
 * @param {{
 *   chromium: import("playwright-core").BrowserType,
 *   test: (name: string, fn: () => Promise<unknown>) => Promise<void>,
 *   args: string[],
 * }} options
 */
export async function runPersistentChecks({ chromium, test, binary, args }) {
  const launch = (userDataDir, extra = {}) =>
    bounded(
      chromium.launchPersistentContext(userDataDir, {
        executablePath: binary,
        headless: true,
        args,
        timeout: OPERATION_TIMEOUT_MS,
        ...extra,
      }),
      "launchPersistentContext",
    );

  await test("persistent launch exposes the default page", async () => {
    const directory = profileDirectory("launch");
    const context = await launch(directory);
    try {
      const pages = context.pages();
      if (pages.length !== 1) throw new Error(`expected one default page, got ${pages.length}`);
      const readyState = await bounded(pages[0].evaluate(() => document.readyState), "default page evaluate");
      if (readyState !== "complete") throw new Error(`default page readyState is ${readyState}`);
      if (!context.browser()) throw new Error("persistent context has no browser()");
      return { pages: pages.length, readyState };
    } finally {
      await bounded(context.close(), "context close");
    }
  });

  await test("persistent profile survives close and relaunch", async () => {
    const directory = profileDirectory("relaunch");
    for (let round = 0; round < 2; round += 1) {
      const context = await launch(directory);
      try {
        const page = context.pages()[0];
        if (!page) throw new Error(`round ${round}: no default page`);
        const value = await bounded(page.evaluate(() => 6 * 7), `round ${round} evaluate`);
        if (value !== 42) throw new Error(`round ${round}: evaluate returned ${value}`);
      } finally {
        await bounded(context.close(), `round ${round} close`);
      }
    }
    return "two rounds";
  });

  await test("persistent profile with pre-existing artifacts", async () => {
    const directory = profileDirectory("legacy");
    // Emulate a profile that already went through a browser run.
    fs.mkdirSync(path.join(directory, "Default"), { recursive: true });
    fs.writeFileSync(path.join(directory, "Default", "Preferences"), JSON.stringify({}), "utf8");
    fs.writeFileSync(path.join(directory, ".seed-sentinel"), "12345\n", "utf8");

    const context = await launch(directory);
    try {
      const page = context.pages()[0];
      if (!page) throw new Error("no default page");
      await bounded(page.evaluate(() => location.href), "evaluate");
    } finally {
      await bounded(context.close(), "close");
    }
    if (!fs.existsSync(path.join(directory, ".seed-sentinel"))) throw new Error("profile sentinel was removed");
    return "legacy profile kept";
  });

  await test("persistent context options are applied", async () => {
    const directory = profileDirectory("options");
    const context = await launch(directory, { viewport: { width: 900, height: 700 }, locale: "de-DE" });
    try {
      const page = context.pages()[0];
      if (!page) throw new Error("no default page");
      const viewport = page.viewportSize();
      if (!viewport || viewport.width !== 900 || viewport.height !== 700) {
        throw new Error(`viewport was ${JSON.stringify(viewport)}`);
      }
      const language = await bounded(page.evaluate(() => navigator.language), "locale evaluate");
      if (!language.toLowerCase().startsWith("de")) throw new Error(`locale was ${language}`);
      return { viewport, language };
    } finally {
      await bounded(context.close(), "close");
    }
  });

  await test("default page survives ephemeral context rotation", async () => {
    const directory = profileDirectory("rotation");
    const context = await launch(directory);
    try {
      const browser = context.browser();
      if (!browser) throw new Error("persistent context has no browser()");
      const defaultPage = context.pages()[0];
      if (!defaultPage) throw new Error("no default page");

      for (let round = 0; round < 2; round += 1) {
        const ephemeral = await bounded(browser.newContext(), `newContext ${round}`);
        const page = await bounded(ephemeral.newPage(), `newPage ${round}`);
        const value = await bounded(page.evaluate(() => 2 + 2), `ephemeral evaluate ${round}`);
        if (value !== 4) throw new Error(`ephemeral evaluate returned ${value}`);
        await bounded(ephemeral.close(), `ephemeral close ${round}`);
      }

      // The default page must still be the same live page afterwards.
      const pages = context.pages();
      if (pages.length !== 1 || pages[0] !== defaultPage) {
        throw new Error(`default page changed after rotation (${pages.length} pages)`);
      }
      const alive = await bounded(defaultPage.evaluate(() => 1 + 1), "default page after rotation");
      if (alive !== 2) throw new Error(`default page returned ${alive}`);
      return { rotations: 2, defaultPageAlive: true };
    } finally {
      await bounded(context.close(), "close");
    }
  });

  await test("persistent navigation and evaluate", async () => {
    const directory = profileDirectory("navigation");
    const context = await launch(directory);
    try {
      const page = context.pages()[0];
      if (!page) throw new Error("no default page");
      await bounded(page.goto("data:text/html,<title>persistent-nav</title>"), "goto");
      const title = await bounded(page.evaluate(() => document.title), "evaluate after goto");
      if (title !== "persistent-nav") throw new Error(`title was ${title}`);
      return title;
    } finally {
      await bounded(context.close(), "close");
    }
  });
}