/**
 * Pointer movement and clicking: a cubic path sampled into `mouse.move` calls,
 * real `mouse.down`/`up` presses, and `touchscreen.tap` for taps.
 */

import type { Page } from "playwright-core";

import { HumanizeCoveredError, HumanizeError } from "../errors.js";
import { randomIn, type HumanConfig } from "./config.js";
import { Deadline } from "./deadline.js";
import { scrollTargetIntoView } from "./scroll.js";
import { boxOf, clampToViewport, viewportOf, waitVisible, type Box, type Target } from "./targets.js";

export interface ClickOptions {
  timeout?: number;
  force?: boolean;
  trial?: boolean;
  position?: { x: number; y: number } | null;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delay?: number;
  modifiers?: string[];
  scroll?: "auto" | "none";
  strict?: boolean;
}

interface PointerState {
  x: number;
  y: number;
  placed: boolean;
}

const POINTERS = new WeakMap<Page, PointerState>();

function pointerFor(page: Page): PointerState {
  let state = POINTERS.get(page);
  if (state === undefined) {
    state = { x: 0, y: 0, placed: false };
    POINTERS.set(page, state);
  }
  return state;
}

/** Forget the tracked pointer position for a page. */
export function resetPointer(page: Page): void {
  POINTERS.delete(page);
}

function randomAnchor(cfg: HumanConfig): { ax: number; ay: number } {
  return {
    ax: randomIn(cfg.anchor, cfg.random),
    ay: randomIn(cfg.anchor, cfg.random),
  };
}

interface Point {
  x: number;
  y: number;
  anchor: { ax: number; ay: number };
}

export function clickPoint(box: Box, position: ClickOptions["position"], cfg: HumanConfig): Point {
  if (position) {
    const ax = box.width > 0 ? position.x / box.width : 0.5;
    const ay = box.height > 0 ? position.y / box.height : 0.5;
    return { x: box.x + position.x, y: box.y + position.y, anchor: { ax, ay } };
  }
  const { ax, ay } = randomAnchor(cfg);
  return { x: box.x + box.width * ax, y: box.y + box.height * ay, anchor: { ax, ay } };
}

function cubic(
  from: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y,
  };
}

/** Move the pointer to `to` along a curved, per-point path. */
export async function movePointer(
  page: Page,
  to: { x: number; y: number },
  cfg: HumanConfig,
  deadline: Deadline,
  api = "humanize.move",
): Promise<void> {
  const state = pointerFor(page);
  if (!state.placed) {
    const viewport = await viewportOf(page);
    state.x = viewport.width / 2;
    state.y = viewport.height / 2;
    state.placed = true;
  }

  const from = { x: state.x, y: state.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.trunc(cfg.pathPoints));

  if (distance < 1) {
    await page.mouse.move(to.x, to.y);
    state.x = to.x;
    state.y = to.y;
    return;
  }

  const bow = (cfg.random() * 2 - 1) * Math.min(cfg.pathCurve, distance / 3);
  const nx = -dy / distance;
  const ny = dx / distance;
  const c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  const c2 = { x: from.x + dx * 0.7 + nx * bow * 0.5, y: from.y + dy * 0.7 + ny * bow * 0.5 };

  for (let step = 1; step <= steps; step += 1) {
    if (deadline.expired()) throw deadline.error(api, "the pointer path");
    const point = cubic(from, c1, c2, to, step / steps);
    await page.mouse.move(point.x, point.y);
    state.x = point.x;
    state.y = point.y;
    await deadline.pause(cfg.random() * 2, api, "the pointer to move");
  }
  state.x = to.x;
  state.y = to.y;
}

async function withModifiers<T>(
  page: Page,
  modifiers: string[] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const held: string[] = [];
  try {
    for (const modifier of modifiers ?? []) {
      await page.keyboard.down(modifier);
      held.push(modifier);
    }
    return await run();
  } finally {
    for (const modifier of held.reverse()) {
      await page.keyboard.up(modifier).catch(() => undefined);
    }
  }
}

async function pressButton(
  page: Page,
  cfg: HumanConfig,
  button: "left" | "right" | "middle",
  clickCount: number,
  delay: number | undefined,
  deadline: Deadline,
  api: string,
): Promise<void> {
  const count = Math.max(1, Math.trunc(clickCount));
  for (let n = 1; n <= count; n += 1) {
    const hold = deadline.cap(delay ?? randomIn(cfg.holdTime, cfg.random));
    await page.mouse.down({ button, clickCount: n });
    try {
      await deadline.pause(hold, api, "the button to be released");
    } finally {
      await page.mouse.up({ button, clickCount: n }).catch(() => undefined);
    }
    if (n < count) {
      await deadline.pause(randomIn(cfg.doubleClickGap, cfg.random), api, "the second press");
    }
  }
}

/** Reject a point another element covers; `force` skips it. */
async function assertPointIsReachable(
  target: Target,
  anchor: { ax: number; ay: number },
  api: string,
): Promise<void> {
  const reachable = await target.locator.evaluate(
    (element: Element, fraction: { ax: number; ay: number }) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width * fraction.ax;
      const y = rect.top + rect.height * fraction.ay;
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === element || element.contains(hit) || hit.contains(element));
    },
    anchor,
  );
  if (!reachable) {
    throw new HumanizeCoveredError(
      `${api}: ${target.description} is covered by another element; pass force: true to click anyway`,
    );
  }
}

interface Aim {
  destination: { x: number; y: number };
}

/** Wait, scroll, pick the point and check it is hittable. */
async function aim(
  target: Target,
  options: ClickOptions,
  cfg: HumanConfig,
  deadline: Deadline,
  api: string,
): Promise<Aim> {
  let box: Box;
  if (options.force === true) {
    // `force` skips the actionability wait, but not the need for a real box.
    const forced = await target.locator.boundingBox();
    if (forced === null || forced.width <= 0 || forced.height <= 0) {
      throw new HumanizeError(`${api}: ${target.description} has no visible box`);
    }
    box = forced;
  } else {
    await waitVisible(target, deadline, api);
    box = await boxOf(target, deadline);
  }

  if (options.scroll !== "none") {
    await scrollTargetIntoView(
      target,
      box,
      cfg,
      deadline,
      (to) => movePointer(target.page, to, cfg, deadline, api),
      api,
    );
    box = await boxOf(target, deadline);
  }

  const point = clickPoint(box, options.position ?? null, cfg);
  const viewport = await viewportOf(target.page);
  const destination = clampToViewport({ x: point.x, y: point.y }, viewport);
  if (options.force !== true) await assertPointIsReachable(target, point.anchor, api);
  return { destination };
}

/** Humanized click on a resolved target. */
export async function humanClick(
  target: Target,
  options: ClickOptions,
  cfg: HumanConfig,
  api: string,
  deadline: Deadline = Deadline.from(options.timeout),
): Promise<void> {
  const { destination } = await aim(target, options, cfg, deadline, api);
  await movePointer(target.page, destination, cfg, deadline, api);
  await deadline.pause(randomIn(cfg.pressPause, cfg.random), api, "the click to land");
  if (options.trial === true) return;

  await withModifiers(target.page, options.modifiers, () =>
    pressButton(
      target.page,
      cfg,
      options.button ?? "left",
      options.clickCount ?? 1,
      options.delay,
      deadline,
      api,
    ),
  );
}

/** Humanized tap: the same aim, then one real touch gesture. */
export async function humanTap(
  target: Target,
  options: ClickOptions,
  cfg: HumanConfig,
  api: string,
  deadline: Deadline = Deadline.from(options.timeout),
): Promise<void> {
  const { destination } = await aim(target, options, cfg, deadline, api);
  await movePointer(target.page, destination, cfg, deadline, api);
  await deadline.pause(randomIn(cfg.pressPause, cfg.random), api, "the tap to land");
  if (options.trial === true) return;

  await withModifiers(target.page, options.modifiers, () =>
    target.page.touchscreen.tap(destination.x, destination.y),
  );
}

/** Humanized hover: move onto the element and stop. */
export async function humanHover(
  target: Target,
  options: ClickOptions,
  cfg: HumanConfig,
  api: string,
  deadline: Deadline = Deadline.from(options.timeout),
): Promise<void> {
  const { destination } = await aim(target, options, cfg, deadline, api);
  await movePointer(target.page, destination, cfg, deadline, api);
}

/** Humanized click at raw viewport coordinates (`Mouse.click`). */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
  options: ClickOptions,
  cfg: HumanConfig,
): Promise<void> {
  const deadline = Deadline.from(options.timeout);
  const viewport = await viewportOf(page);
  await movePointer(page, clampToViewport({ x, y }, viewport), cfg, deadline, "mouse.click");
  await deadline.pause(randomIn(cfg.pressPause, cfg.random), "mouse.click", "the click to land");
  if (options.trial === true) return;
  await pressButton(
    page,
    cfg,
    options.button ?? "left",
    options.clickCount ?? 1,
    options.delay,
    deadline,
    "mouse.click",
  );
}
