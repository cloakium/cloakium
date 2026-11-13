/**
 * Humanize wiring. `Page`, `Frame`, `Locator`, `Mouse` and `Keyboard`
 * prototypes are patched once; every wrapper checks a per-page marker, so an
 * unpatched page always keeps Playwright's own behaviour. Config lives in
 * mutable holders, so re-patching applies to current *and* future targets.
 */

import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";

import { ACTIONS, clickOptions, LAYOUTS } from "./actions.js";
import type { HumanConfig } from "./config.js";
import { Deadline } from "./deadline.js";
import { typeText } from "./keyboard.js";
import { NATIVE } from "./native.js";
import { clickAt, resetPointer } from "./pointer.js";
import {
  targetFromFrame,
  targetFromLocator,
  targetFromSelector,
  type Target,
} from "./targets.js";
import { wheelNotches } from "./wheel.js";

const STATE = Symbol.for("cloakium.human.state");
const CONTEXT_STATE = Symbol.for("cloakium.human.context");
const BROWSER_STATE = Symbol.for("cloakium.human.browser");
const PATCHED = Symbol.for("cloakium.human.patched");

type AnyFn = (...args: any[]) => any;
type Kind = "page" | "frame" | "locator";

interface ConfigState {
  cfg: HumanConfig;
}

const MOUSE_PAGES = new WeakMap<object, Page>();
const KEYBOARD_PAGES = new WeakMap<object, Page>();

function stateOfPage(page: Page | undefined): ConfigState | undefined {
  if (!page) return undefined;
  return (page as unknown as { [STATE]?: ConfigState })[STATE];
}

function stateOf(target: object, key: symbol): ConfigState | undefined {
  return (target as unknown as { [index: symbol]: ConfigState | undefined })[key];
}

function setState(target: object, key: symbol, state: ConfigState): void {
  (target as unknown as { [index: symbol]: ConfigState })[key] = state;
}

function patchMethod(
  prototype: any,
  name: string,
  handler: (native: AnyFn, self: any, args: any[]) => any,
): void {
  const current = prototype[name];
  if (typeof current !== "function") return;
  if (current[PATCHED] === true) return;

  const wrapper = function (this: any, ...args: any[]) {
    return handler(current, this, args);
  };
  Object.defineProperty(wrapper, "name", { value: name });
  (wrapper as any)[PATCHED] = true;
  (wrapper as any)[NATIVE] = current;
  prototype[name] = wrapper;
}

function dispatch(
  kind: Kind,
  method: string,
  native: AnyFn,
  self: any,
  args: any[],
): unknown {
  const page: Page | undefined =
    kind === "locator"
      ? (self as Locator).page()
      : kind === "page"
        ? (self as Page)
        : (self as Frame).page();
  const state = stateOfPage(page);
  if (state === undefined) return native.apply(self, args);

  const layout = LAYOUTS[method]!;
  const [optionsIndex, restIndex] = kind === "locator" ? layout.locator : layout.selector;
  const options = args[optionsIndex] ?? {};
  const rest = restIndex < args.length ? [args[restIndex]] : [];

  let target: Target;
  if (kind === "locator") {
    target = targetFromLocator(self as Locator);
  } else if (kind === "page") {
    target = targetFromSelector(page!, String(args[0]), options.strict === true);
  } else {
    target = targetFromFrame(self as unknown as Frame, String(args[0]), options.strict === true);
  }

  return ACTIONS[method]!({
    target,
    options,
    rest,
    cfg: state.cfg,
    deadline: deadlineFor(options),
    api: `${kind}.${method}`,
  });
}

function deadlineFor(options: any): Deadline {
  return Deadline.from(options?.timeout);
}

function patchSelectorMethods(prototype: any, kind: "page" | "frame"): void {
  for (const method of Object.keys(LAYOUTS)) {
    patchMethod(prototype, method, (native, self, args) => dispatch(kind, method, native, self, args));
  }
}

function patchLocatorMethods(prototype: any): void {
  for (const method of Object.keys(LAYOUTS)) {
    patchMethod(prototype, method, (native, self, args) => dispatch("locator", method, native, self, args));
  }
  patchMethod(prototype, "clear", (native, self, args) => {
    const state = stateOfPage((self as Locator).page());
    if (state === undefined) return native.apply(self, args);
    const options = args[0] ?? {};
    return ACTIONS.clear!({
      target: targetFromLocator(self as Locator),
      options,
      rest: [],
      cfg: state.cfg,
      deadline: deadlineFor(options),
      api: "locator.clear",
    });
  });
}

function patchMouseMethods(prototype: any): void {
  patchMethod(prototype, "click", (native, self, args) => {
    const page = MOUSE_PAGES.get(self);
    const state = stateOfPage(page);
    if (page === undefined || state === undefined) return native.apply(self, args);
    const [x, y, options] = args;
    return clickAt(page, Number(x), Number(y), clickOptions(options), state.cfg);
  });

  patchMethod(prototype, "dblclick", (native, self, args) => {
    const page = MOUSE_PAGES.get(self);
    const state = stateOfPage(page);
    if (page === undefined || state === undefined) return native.apply(self, args);
    const [x, y, options] = args;
    return clickAt(page, Number(x), Number(y), { ...clickOptions(options), clickCount: 2 }, state.cfg);
  });

  patchMethod(prototype, "wheel", (native, self, args) => {
    const page = MOUSE_PAGES.get(self);
    const state = stateOfPage(page);
    if (page === undefined || state === undefined) return native.apply(self, args);
    const [deltaX, deltaY] = args;
    if (Number(deltaX) !== 0) return native.apply(self, args);
    return wheelNotches(page, Number(deltaY), state.cfg, Deadline.from(undefined));
  });
}

function patchKeyboardMethods(prototype: any): void {
  patchMethod(prototype, "type", (native, self, args) => {
    const page = KEYBOARD_PAGES.get(self);
    const state = stateOfPage(page);
    if (page === undefined || state === undefined) return native.apply(self, args);
    const [text, options] = args;
    const deadline = deadlineFor(options);
    return typeText(page, String(text), state.cfg, deadline, options?.delay, "keyboard.type");
  });
}

function patchPrototypes(page: Page): void {
  patchSelectorMethods(Object.getPrototypeOf(page), "page");
  patchSelectorMethods(Object.getPrototypeOf(page.mainFrame()), "frame");
  patchLocatorMethods(Object.getPrototypeOf(page.locator(":root")));
  patchMouseMethods(Object.getPrototypeOf(page.mouse));
  patchKeyboardMethods(Object.getPrototypeOf(page.keyboard));
}

/** Patch one page. Re-patching replaces the config without stacking wrappers. */
export function patchPage(page: Page, cfg: HumanConfig): void {
  const existing = stateOfPage(page);
  if (existing !== undefined) {
    existing.cfg = cfg;
    return;
  }
  setState(page, STATE, { cfg });
  MOUSE_PAGES.set(page.mouse as unknown as object, page);
  KEYBOARD_PAGES.set(page.keyboard as unknown as object, page);
  patchPrototypes(page);
  resetPointer(page);
}

/**
 * Patch every page of a context, and every page it creates later. Re-patching
 * updates the same holder, so future pages read the new configuration.
 */
export function patchContext(context: BrowserContext, cfg: HumanConfig): void {
  let state = stateOf(context, CONTEXT_STATE);
  if (state === undefined) {
    state = { cfg };
    setState(context, CONTEXT_STATE, state);
    const holder = state;
    context.on("page", (page: Page) => {
      if (stateOfPage(page) === undefined) patchPage(page, holder.cfg);
    });
  } else {
    state.cfg = cfg;
  }
  for (const page of context.pages()) patchPage(page, cfg);
}

/**
 * Patch a browser: its contexts, every page they create, and every context or
 * page created from the browser itself. Re-patching updates the holder used by
 * those callbacks, so a new target never inherits a stale configuration.
 */
export function patchBrowser(browser: Browser, cfg: HumanConfig): void {
  const state = stateOf(browser, BROWSER_STATE);
  if (state === undefined) {
    const holder: ConfigState = { cfg };
    setState(browser, BROWSER_STATE, holder);

    const nativeNewContext = browser.newContext.bind(browser);
    (browser as unknown as { newContext: typeof nativeNewContext }).newContext = async (
      options?: Parameters<typeof nativeNewContext>[0],
    ) => {
      const context = await nativeNewContext(options);
      patchContext(context, holder.cfg);
      return context;
    };

    const nativeNewPage = browser.newPage.bind(browser);
    (browser as unknown as { newPage: typeof nativeNewPage }).newPage = async (
      options?: Parameters<typeof nativeNewPage>[0],
    ) => {
      const page = await nativeNewPage(options);
      patchContext(page.context(), holder.cfg);
      if (stateOfPage(page) === undefined) patchPage(page, holder.cfg);
      return page;
    };
  } else {
    state.cfg = cfg;
  }
  browser.contexts().forEach((context) => patchContext(context, cfg));
}
