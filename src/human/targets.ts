/**
 * Action targets: one abstraction over `Page`/`Frame` selectors and `Locator`s.
 * Actionability is delegated to Playwright, so its auto-wait, strictness and
 * timeout rules still decide when an element is ready.
 */

import { errors } from "playwright-core";
import type { Frame, Locator, Page } from "playwright-core";

import { HumanizeTimeoutError } from "../errors.js";
import { sleep } from "./config.js";
import type { Deadline } from "./deadline.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Target {
  page: Page;
  locator: Locator;
  description: string;
}

export function targetFromLocator(locator: Locator): Target {
  return { page: locator.page(), locator, description: String(locator) };
}

/**
 * Selector-based target. Playwright's `page.click(selector)` uses the first
 * match unless `strict` is requested; a `Locator` is strict, so `.first()`
 * reproduces that.
 */
export function targetFromSelector(page: Page, selector: string, strict: boolean): Target {
  const locator = page.locator(selector);
  return {
    page,
    locator: strict ? locator : locator.first(),
    description: `locator(${JSON.stringify(selector)})`,
  };
}

export function targetFromFrame(frame: Frame, selector: string, strict: boolean): Target {
  const locator = frame.locator(selector);
  return {
    page: frame.page(),
    locator: strict ? locator : locator.first(),
    description: `locator(${JSON.stringify(selector)})`,
  };
}

/** Wait until Playwright considers the element visible (auto-wait). */
export async function waitVisible(target: Target, deadline: Deadline, api: string): Promise<void> {
  if (deadline.expired()) throw deadline.error(api, target.description);
  try {
    await target.locator.waitFor({ state: "visible", timeout: deadline.remaining() });
  } catch (error) {
    // Only a spent explicit budget is re-reported in the wrapper's terms; an
    // inherited page default keeps Playwright's own TimeoutError.
    if (error instanceof errors.TimeoutError && deadline.timeout !== undefined && deadline.timeout > 0) {
      throw deadline.error(api, target.description);
    }
    throw error;
  }
}

/** Current border box in viewport coordinates, or a timeout. */
export async function boxOf(target: Target, deadline: Deadline): Promise<Box> {
  const started = Date.now();
  for (;;) {
    const box = await target.locator.boundingBox();
    if (box !== null && box.width > 0 && box.height > 0) return box;
    // Safety valve: `timeout: 0` must not turn a detached element into a hang.
    if (deadline.expired() || Date.now() - started >= 30_000) {
      throw new HumanizeTimeoutError(`[cloakium] ${target.description} has no visible box`);
    }
    await sleep(16);
  }
}

export async function isEditable(target: Target, deadline: Deadline, api: string): Promise<boolean> {
  try {
    return await target.locator.isEditable({
      timeout: deadline.forPlaywright(api, target.description),
    });
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

/** `Locator.isChecked` with Playwright's strictness and timeout errors intact. */
export async function isChecked(target: Target, deadline: Deadline, api: string): Promise<boolean> {
  return target.locator.isChecked({
    timeout: deadline.forPlaywright(api, target.description),
  });
}

export async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  const size = page.viewportSize();
  if (size !== null && size.width > 0 && size.height > 0) return size;
  const measured = (await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))) as { width: number; height: number };
  if (measured.width > 0 && measured.height > 0) return measured;
  return { width: 1280, height: 720 };
}

/** `true` when the point (viewport coordinates) is inside the viewport. */
export function pointInViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
}

/** Clamp a viewport coordinate into the usable area. */
export function clampToViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const margin = 2;
  return {
    x: Math.min(Math.max(point.x, margin), Math.max(margin, viewport.width - margin)),
    y: Math.min(Math.max(point.y, margin), Math.max(margin, viewport.height - margin)),
  };
}
