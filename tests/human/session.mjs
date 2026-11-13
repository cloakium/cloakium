/** Shared session helper for the humanize suites. */

import { launch } from "../../dist/index.js";
import { sandboxArgs } from "../browser/browser-env.mjs";
import { startFixture } from "./fixture.mjs";

let fixture;

export async function fixtureUrl() {
  fixture ??= await startFixture();
  return fixture.url;
}

export async function openSession({ humanize = true, humanConfig, contextOptions } = {}) {
  const browser = await launch({
    headless: true,
    humanize,
    humanConfig,
    args: sandboxArgs(),
    launchOptions: { timeout: 60_000 },
  });
  const context = await browser.newContext(contextOptions ?? {});
  const page = await context.newPage();
  await page.goto(await fixtureUrl());
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
