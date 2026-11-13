/** The humanized action table shared by the page, frame and locator patches. */

import { HumanizeError } from "../errors.js";
import { randomIn } from "./config.js";
import type { HumanConfig } from "./config.js";
import { Deadline } from "./deadline.js";
import { clearField, pressKey, typeText } from "./keyboard.js";
import { humanClick, humanHover, humanTap, movePointer, type ClickOptions } from "./pointer.js";
import { scrollTargetIntoView } from "./scroll.js";
import { boxOf, isChecked, isEditable, waitVisible, type Target } from "./targets.js";

export interface ActionContext {
  target: Target;
  options: any;
  rest: any[];
  cfg: HumanConfig;
  deadline: Deadline;
  api: string;
}

export type Action = (context: ActionContext) => Promise<unknown>;

export function clickOptions(options: any): ClickOptions {
  return {
    timeout: options?.timeout,
    force: options?.force === true,
    trial: options?.trial === true,
    position: options?.position ?? null,
    button: options?.button,
    clickCount: options?.clickCount,
    delay: options?.delay,
    modifiers: options?.modifiers,
    // `click` uses "auto"/"none"; `tap` uses a boolean.
    scroll: options?.scroll === false ? "none" : options?.scroll,
    strict: options?.strict,
  };
}

/** Playwright's `force` skips the actionability wait. */
async function awaitActionable(context: ActionContext): Promise<void> {
  if (context.options.force !== true) {
    await waitVisible(context.target, context.deadline, context.api);
  }
}

async function focusByClick(context: ActionContext): Promise<void> {
  await humanClick(
    context.target,
    { ...clickOptions(context.options), clickCount: 1 },
    context.cfg,
    context.api,
    context.deadline,
  );
  await context.deadline.pause(
    randomIn(context.cfg.focusPause, context.cfg.random),
    context.api,
    "the field to take focus",
  );
}

/** Focus a field, replace its contents, then type `text`. */
async function typeInto(context: ActionContext, text: string, replace: boolean): Promise<void> {
  const { deadline, api, target, cfg } = context;
  await awaitActionable(context);
  if (replace && context.options.force !== true && !(await isEditable(target, deadline, api))) {
    throw new HumanizeError(`${api}: ${target.description} is not editable`);
  }
  await focusByClick(context);
  if (replace) await clearField(target.page, cfg, deadline, api);
  await typeText(target.page, text, cfg, deadline, context.options.delay, api);
}

async function setChecked(context: ActionContext, wanted: boolean): Promise<void> {
  const { deadline, api, target } = context;
  await awaitActionable(context);
  if ((await isChecked(target, deadline, api)) === wanted) return;
  await humanClick(
    target,
    { ...clickOptions(context.options), clickCount: 1 },
    context.cfg,
    api,
    deadline,
  );
  if ((await isChecked(target, deadline, api)) !== wanted) {
    throw new HumanizeError(
      `${api}: clicking ${target.description} did not ${wanted ? "check" : "uncheck"} it`,
    );
  }
}

async function scrollTo(context: ActionContext): Promise<void> {
  const { deadline, api, target, cfg } = context;
  await waitVisible(target, deadline, api);
  await scrollTargetIntoView(
    target,
    await boxOf(target, deadline),
    cfg,
    deadline,
    (point) => movePointer(target.page, point, cfg, deadline, api),
    api,
  );
}

export const ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  click: (context) =>
    humanClick(context.target, clickOptions(context.options), context.cfg, context.api, context.deadline),

  dblclick: (context) =>
    humanClick(
      context.target,
      { ...clickOptions(context.options), clickCount: 2 },
      context.cfg,
      context.api,
      context.deadline,
    ),

  tap: (context) =>
    humanTap(context.target, clickOptions(context.options), context.cfg, context.api, context.deadline),

  hover: (context) =>
    humanHover(context.target, clickOptions(context.options), context.cfg, context.api, context.deadline),

  fill: (context) => typeInto(context, String(context.rest[0] ?? ""), true),

  type: (context) => typeInto(context, String(context.rest[0] ?? ""), false),

  pressSequentially: (context) => typeInto(context, String(context.rest[0] ?? ""), false),

  press: async (context) => {
    const key = String(context.rest[0] ?? "");
    await awaitActionable(context);
    await focusByClick(context);
    await pressKey(
      context.target.page,
      key,
      context.cfg,
      context.deadline,
      context.options.delay,
      context.api,
    );
  },

  check: (context) => setChecked(context, true),
  uncheck: (context) => setChecked(context, false),
  setChecked: (context) => setChecked(context, context.rest[0] === true),

  focus: async (context) => {
    await scrollTo(context);
    // Focus is a state change, not an input event; Playwright's focus is honest.
    await context.target.locator.focus({
      timeout: context.deadline.forPlaywright(context.api, context.target.description),
    });
  },

  scrollIntoViewIfNeeded: (context) => scrollTo(context),

  clear: async (context) => {
    await awaitActionable(context);
    await focusByClick(context);
    await clearField(
      context.target.page,
      context.cfg,
      context.deadline,
      context.api,
    );
  },
});

/** Where each method keeps `options` and its value argument. */
export const LAYOUTS: Readonly<
  Record<string, { selector: [number, number]; locator: [number, number] }>
> = Object.freeze({
  click: { selector: [1, 2], locator: [0, 1] },
  dblclick: { selector: [1, 2], locator: [0, 1] },
  tap: { selector: [1, 2], locator: [0, 1] },
  hover: { selector: [1, 2], locator: [0, 1] },
  check: { selector: [1, 2], locator: [0, 1] },
  uncheck: { selector: [1, 2], locator: [0, 1] },
  focus: { selector: [1, 2], locator: [0, 1] },
  scrollIntoViewIfNeeded: { selector: [1, 2], locator: [0, 1] },
  fill: { selector: [2, 1], locator: [1, 0] },
  type: { selector: [2, 1], locator: [1, 0] },
  pressSequentially: { selector: [2, 1], locator: [1, 0] },
  press: { selector: [2, 1], locator: [1, 0] },
  setChecked: { selector: [2, 1], locator: [1, 0] },
});
