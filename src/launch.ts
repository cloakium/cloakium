// Public Playwright launch APIs with explicit host binaries and profile defaults.

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions as PlaywrightLaunchOptions,
} from "playwright-core";

import { buildArgs } from "./args.js";
import { resolveBinaryPath } from "./binary.js";
import { IGNORE_DEFAULT_ARGS } from "./config.js";
import { maybeResolveGeoip } from "./geoip/index.js";
import { applyProfileSeed } from "./profile-seed.js";
import { proxySecrets, resolveProxyConfig } from "./proxy.js";
import { scrubError } from "./redact.js";
import type {
  LaunchContextOptions,
  LaunchOptions,
  LaunchPersistentContextOptions,
  ProxyConfigInput,
} from "./types.js";

const DEFAULTS_MARK = Symbol.for("cloakium.launch.defaults");

interface GeoSignals {
  timezone?: string;
  locale?: string;
}

/** Accept `timezoneId` as an alias of `timezone`. */
export function resolveTimezone<T extends { timezone?: string; timezoneId?: string }>(options: T): T {
  if (options.timezoneId === undefined || options.timezoneId === null) return options;
  const merged: T & { timezoneId?: string } = { ...options, timezone: options.timezone ?? options.timezoneId };
  delete merged.timezoneId;
  return merged;
}

/**
 * Playwright context options with the wrapper's defaults. An explicit
 * `viewport` (including `null`) always wins; otherwise the page tracks the real
 * window instead of Playwright's 1280×720 emulation.
 */
export function buildContextOptions(options: LaunchContextOptions = {}): BrowserContextOptions {
  const explicitViewport =
    options.viewport !== undefined ? options.viewport : options.contextOptions?.viewport;
  const viewport = explicitViewport === undefined ? null : explicitViewport;

  return {
    ...(options.contextOptions ?? {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    viewport,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.timezone ? { timezoneId: options.timezone } : {}),
    ...(options.colorScheme !== undefined ? { colorScheme: options.colorScheme } : {}),
  };
}

async function resolveGeo(options: LaunchOptions): Promise<GeoSignals> {
  return maybeResolveGeoip({
    geoip: options.geoip,
    geoipResolver: options.geoipResolver,
    proxy: options.proxy,
    timezone: options.timezone,
    locale: options.locale,
  });
}

async function prepare(
  options: LaunchOptions,
  geo: GeoSignals,
): Promise<PlaywrightLaunchOptions> {
  const timezone = geo.timezone ?? options.timezone;
  const locale = geo.locale ?? options.locale;

  const args = buildArgs({
    ...options,
    ...(timezone !== undefined ? { timezone } : {}),
    ...(locale !== undefined ? { locale } : {}),
  });
  const { env, proxy: rawProxy, ...rest } = options.launchOptions ?? {};
  // A proxy passed through `launchOptions` is normalised too, so a credentialed
  // URL can never reach Chromium's `--proxy-server` switch.
  const { proxy } = resolveProxyConfig(
    options.proxy ?? (rawProxy as string | ProxyConfigInput | undefined),
  );

  // Wrapper fields win over `launchOptions`: the executable, proxy, args and
  // headless flag are this package's contract. A full default-arg replacement
  // stays possible with an explicit `ignoreDefaultArgs: true`.
  return {
    ...rest,
    executablePath: resolveBinaryPath(),
    headless: options.headless ?? true,
    chromiumSandbox: rest.chromiumSandbox ?? true,
    args,
    ignoreDefaultArgs: rest.ignoreDefaultArgs === true ? true : [...IGNORE_DEFAULT_ARGS],
    ...(proxy ? { proxy } : {}),
    ...(env !== undefined
      ? { env: env as Record<string, string | number | boolean> }
      : {}),
  } as PlaywrightLaunchOptions;
}

/** Redact proxy credentials from anything a launch step throws. */
async function scrubbed<T>(options: LaunchOptions, run: () => Promise<T>): Promise<T> {
  const secrets = [
    ...proxySecrets(options.proxy),
    ...proxySecrets(options.launchOptions?.proxy),
  ];
  try {
    return await run();
  } catch (error) {
    throw scrubError(error, secrets);
  }
}

/** Build launch options without starting Chromium (useful for tests/embedding). */
export async function buildLaunchOptions(
  options: LaunchOptions = {},
): Promise<PlaywrightLaunchOptions> {
  return scrubbed(options, async () => prepare(options, await resolveGeo(options)));
}

/**
 * Apply locale/timezone/viewport defaults to every context the browser creates.
 * Idempotent per browser, so `launch()` + `humanizeBrowser()` compose safely.
 */
function applyContextDefaults(browser: Browser, geo: GeoSignals): void {
  const tagged = browser as unknown as { [DEFAULTS_MARK]?: GeoSignals };
  if (tagged[DEFAULTS_MARK] !== undefined) return;
  tagged[DEFAULTS_MARK] = geo;

  const nativeNewContext = browser.newContext.bind(browser);
  const nativeNewPage = browser.newPage.bind(browser);

  const withDefaults = (options?: BrowserContextOptions): BrowserContextOptions => {
    const next: BrowserContextOptions = { ...(options ?? {}) };
    if (next.viewport === undefined) next.viewport = null;
    if (next.locale === undefined && geo.locale !== undefined) next.locale = geo.locale;
    if (next.timezoneId === undefined && geo.timezone !== undefined) next.timezoneId = geo.timezone;
    return next;
  };

  (browser as unknown as { newContext: typeof nativeNewContext }).newContext = (
    options?: BrowserContextOptions,
  ) => nativeNewContext(withDefaults(options));
  (browser as unknown as { newPage: typeof nativeNewPage }).newPage = (
    options?: BrowserContextOptions,
  ) => nativeNewPage(withDefaults(options));
}

/** Apply the humanize layer to an existing browser when requested. */
export async function humanizeBrowser(browser: Browser, options: LaunchOptions = {}): Promise<void> {
  if (options.humanize !== true) return;
  const [{ patchBrowser }, { resolveConfig }] = await Promise.all([
    import("./human/index.js"),
    import("./human/config.js"),
  ]);
  patchBrowser(browser, resolveConfig(options.humanPreset, options.humanConfig));
}

/** Launch Chromium and return the Playwright `Browser`. */
export async function launch(options: LaunchOptions = {}): Promise<Browser> {
  return scrubbed(options, async () => {
    const geo = await resolveGeo(options);
    const launchOptions = await prepare(options, geo);
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch(launchOptions);
    applyContextDefaults(browser, {
      ...(geo.timezone !== undefined || options.timezone !== undefined
        ? { timezone: geo.timezone ?? options.timezone }
        : {}),
      ...(geo.locale !== undefined || options.locale !== undefined
        ? { locale: geo.locale ?? options.locale }
        : {}),
    });
    await humanizeBrowser(browser, options);
    return browser;
  });
}

/** Launch and return a context; closing it closes the browser too. */
export async function launchContext(options: LaunchContextOptions = {}): Promise<BrowserContext> {
  return scrubbed(options, async () => {
    const resolved = resolveTimezone(options);
    const geo = await resolveGeo(resolved);
    const merged: LaunchContextOptions = {
      ...resolved,
      ...(geo.timezone !== undefined ? { timezone: geo.timezone } : {}),
      ...(geo.locale !== undefined ? { locale: geo.locale } : {}),
    };
    const browser = await launch({ ...merged, geoip: false, humanize: false });

    let context: BrowserContext;
    try {
      context = await browser.newContext(buildContextOptions(merged));
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }

    const nativeClose = context.close.bind(context);
    context.close = async (closeOptions?: { reason?: string }) => {
      try {
        await nativeClose(closeOptions ?? {});
      } finally {
        await browser.close().catch(() => undefined);
      }
    };

    if (merged.humanize === true) {
      const [{ patchContext }, { resolveConfig }] = await Promise.all([
        import("./human/index.js"),
        import("./human/config.js"),
      ]);
      patchContext(context, resolveConfig(merged.humanPreset, merged.humanConfig));
    }
    return context;
  });
}

/** Launch a persistent profile and return Playwright's context for it. */
export async function launchPersistentContext(
  options: LaunchPersistentContextOptions,
): Promise<BrowserContext> {
  return scrubbed(options, async () => {
    const resolved = resolveTimezone(options);
    const geo = await resolveGeo(resolved);
    const merged: LaunchPersistentContextOptions = {
      ...resolved,
      ...(geo.timezone !== undefined ? { timezone: geo.timezone } : {}),
      ...(geo.locale !== undefined ? { locale: geo.locale } : {}),
      args: applyProfileSeed(resolved.userDataDir, resolved.stealthArgs, resolved.args),
    };

    const launchOptions = await prepare({ ...merged, geoip: false }, geo);
    const { chromium } = await import("playwright-core");
    // Context options win over the forwarded launch options, matching
    // `buildContextOptions` precedence.
    const context = await chromium.launchPersistentContext(resolved.userDataDir, {
      ...launchOptions,
      ...buildContextOptions(merged),
    });

    if (merged.humanize === true) {
      const [{ patchContext }, { resolveConfig }] = await Promise.all([
        import("./human/index.js"),
        import("./human/config.js"),
      ]);
      patchContext(context, resolveConfig(merged.humanPreset, merged.humanConfig));
    }
    return context;
  });
}

/** @internal exposed so tests can assert argument assembly. */
export { buildArgs as _buildArgs };
