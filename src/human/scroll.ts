/**
 * Wheel-driven scrolling: turn the wheel in notches while re-measuring the box.
 * When the wheel cannot move the element, Playwright's own scroll is used once
 * as an explicit fallback (reported in the docs).
 */

import type { HumanConfig } from "./config.js";
import type { Deadline } from "./deadline.js";
import { clampToViewport, viewportOf, type Box, type Target } from "./targets.js";
import { wheelNotches } from "./wheel.js";

export function boxInViewport(box: Box, viewport: { width: number; height: number }): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
}

function deltaFor(box: Box, viewport: { width: number; height: number }): number {
  const margin = 8;
  if (box.y < 0) return box.y - margin;
  const bottom = box.y + box.height;
  if (bottom > viewport.height) return bottom - viewport.height + margin;
  return 0;
}

async function scrollOffset(page: Target["page"]): Promise<number> {
  try {
    return (await page.evaluate(() => window.scrollY)) as number;
  } catch {
    return 0;
  }
}

/** Scroll until `box` is fully inside the viewport, moving the pointer first. */
export async function scrollTargetIntoView(
  target: Target,
  box: Box,
  cfg: HumanConfig,
  deadline: Deadline,
  moveTo: (point: { x: number; y: number }) => Promise<void>,
  api = "humanize.scroll",
): Promise<void> {
  const page = target.page;
  const viewport = await viewportOf(page);
  if (boxInViewport(box, viewport)) return;

  await moveTo(clampToViewport({ x: viewport.width / 2, y: viewport.height / 2 }, viewport));

  let current = box;
  let stalls = 0;

  for (let round = 0; round < cfg.scrollRounds; round += 1) {
    if (deadline.expired()) break;
    if (boxInViewport(current, viewport)) return;

    const delta = deltaFor(current, viewport);
    if (delta === 0) return;

    const before = await scrollOffset(page);
    await wheelNotches(page, delta, cfg, deadline, api);
    const after = await scrollOffset(page);
    await deadline.pause(cfg.random() * 8, api, "the page to settle");

    const next = await target.locator.boundingBox();
    if (next === null) break;
    const moved = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    current = next;

    if (moved < 1 && after === before) {
      stalls += 1;
      if (stalls >= 2) break;
    } else {
      stalls = 0;
    }
  }

  if (boxInViewport(current, viewport)) return;

  // The wheel could not move this container: Playwright's instant scroll is the
  // documented fallback.
  await target.locator
    .scrollIntoViewIfNeeded({ timeout: deadline.forPlaywright(api, target.description) })
    .catch(() => undefined);
}
