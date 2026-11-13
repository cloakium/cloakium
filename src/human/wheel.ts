/** Wheel input. `rawWheel` always reaches Playwright's original method. */

import type { Page } from "playwright-core";

import { randomIn, type HumanConfig } from "./config.js";
import type { Deadline } from "./deadline.js";
import { nativeOf } from "./native.js";

async function rawWheel(page: Page, deltaX: number, deltaY: number): Promise<void> {
  const native = nativeOf(page.mouse.wheel);
  await native.call(page.mouse, deltaX, deltaY);
}

/** Scroll `deltaY` in whole notches, pausing between them. */
export async function wheelNotches(
  page: Page,
  deltaY: number,
  cfg: HumanConfig,
  deadline: Deadline,
  api = "humanize.wheel",
): Promise<void> {
  if (!Number.isFinite(deltaY) || deltaY === 0) return;
  const notches = Math.min(40, Math.max(1, Math.round(Math.abs(deltaY) / cfg.wheelNotch)));
  const direction = deltaY > 0 ? 1 : -1;
  for (let notch = 0; notch < notches; notch += 1) {
    if (deadline.expired()) throw deadline.error(api, "the wheel to scroll");
    await rawWheel(page, 0, direction * cfg.wheelNotch);
    await deadline.pause(randomIn(cfg.wheelPause, cfg.random), api, "the wheel to settle");
  }
}
