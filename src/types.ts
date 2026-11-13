/**
 * Public option types.
 *
 * The shape mirrors the option names Harvest already passes (`headless`,
 * `proxy`, `args`, `locale`, `geoip`, `humanize`, `launchTimeoutMs` is not part
 * of this package — callers put it in `launchOptions.timeout`).
 */

import type { BrowserContextOptions } from "playwright-core";

import type { GeoResolver } from "./geoip/index.js";
import type { HumanConfig, HumanPreset } from "./human/config.js";

/** Playwright-style proxy object or a `http(s)://`/`socks5://` URL string. */
export interface ProxyConfigInput {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export interface LaunchOptions {
  /** Run without a window. Defaults to `true` (Playwright's own default). */
  headless?: boolean;
  /**
   * Proxy for the browser. Playwright installs it, so `context.request` is
   * proxied too. Credentials must be separate fields (or URL userinfo for
   * HTTP(S)); SOCKS proxies cannot carry credentials.
   */
  proxy?: string | ProxyConfigInput;
  /** Extra Chromium switches, applied after the wrapper's own defaults. */
  args?: string[];
  /** Unpacked extension directories to load. */
  extensionPaths?: string[];
  /**
   * Emit the default privacy switches (`--fingerprint=<seed>` plus the WebRTC
   * IP handling policy). Default `true`; `false` leaves the browser's own
   * defaults untouched.
   */
  stealthArgs?: boolean;
  /** Fixed fingerprint seed. When omitted a random 5-digit seed is used. */
  fingerprintSeed?: string | number;
  /** IANA timezone, applied through Playwright's context emulation. */
  timezone?: string;
  /** BCP 47 locale, applied through Playwright's context emulation. */
  locale?: string;
  /**
   * Resolve timezone/locale from the egress IP. Requires either a GeoIP
   * database (`CLOAKIUM_GEOIP_DB`) or a `geoipResolver`; there is no download.
   */
  geoip?: boolean;
  /** Caller-supplied replacement for the database lookup. */
  geoipResolver?: GeoResolver;
  /** Raw options forwarded to `chromium.launch()` / `launchPersistentContext()`. */
  launchOptions?: Record<string, unknown>;
  /** Patch this browser/page for humanized input. Off by default. */
  humanize?: boolean;
  /** Humanize preset name. */
  humanPreset?: HumanPreset;
  /** Per-field humanize overrides, validated against `HumanConfig`. */
  humanConfig?: Partial<HumanConfig>;
}

export interface LaunchContextOptions extends LaunchOptions {
  /** Context user agent. Leave unset to keep the binary's own identity. */
  userAgent?: string;
  /** Explicit viewport; `null` disables emulation. Defaults to `null`. */
  viewport?: { width: number; height: number } | null;
  /** Alias of `timezone`. */
  timezoneId?: string;
  /** Playwright context colour-scheme emulation. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Extra `newContext()` options. Wrapper fields above take precedence. */
  contextOptions?: BrowserContextOptions;
}

export interface LaunchPersistentContextOptions extends LaunchContextOptions {
  /** Profile directory. The wrapper keeps the profile's fingerprint seed here. */
  userDataDir: string;
}
