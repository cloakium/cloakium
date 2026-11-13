/**
 * Humanize configuration.
 *
 * Everything is a plain number/range so callers can persist and override it.
 * `random` is injectable, which is what makes the tests deterministic.
 */

import { ConfigurationError } from "../errors.js";

export type HumanPreset = "default" | "careful";

export interface HumanConfig {
  /** Points sampled along the pointer path. */
  pathPoints: number;
  /** Sideways bow of the pointer path, in CSS px. */
  pathCurve: number;
  /** Click position inside the element, as fractions of its box. */
  anchor: [number, number];
  /** Pause between arriving and pressing, ms. */
  pressPause: [number, number];
  /** Button hold time, ms. */
  holdTime: [number, number];
  /** Gap between the presses of a double click, ms. */
  doubleClickGap: [number, number];
  /** Gap between typed characters, ms. */
  keyGap: [number, number];
  /** Key hold time, ms. */
  keyHold: [number, number];
  /** Pause after focusing a field, before the first key, ms. */
  focusPause: [number, number];
  /** Wheel notch size, in CSS px. */
  wheelNotch: number;
  /** Pause between wheel notches, ms. */
  wheelPause: [number, number];
  /** Wheel rounds before falling back to Playwright's scroll. */
  scrollRounds: number;
  /** Probability of a corrected typo per character (0..1). */
  mistakeChance: number;
  /** Random source. */
  random: () => number;
}

type RangeKey =
  | "anchor"
  | "pressPause"
  | "holdTime"
  | "doubleClickGap"
  | "keyGap"
  | "keyHold"
  | "focusPause"
  | "wheelPause";

const RANGE_KEYS: readonly RangeKey[] = [
  "anchor",
  "pressPause",
  "holdTime",
  "doubleClickGap",
  "keyGap",
  "keyHold",
  "focusPause",
  "wheelPause",
];

const NUMBER_KEYS = [
  "pathPoints",
  "pathCurve",
  "wheelNotch",
  "scrollRounds",
  "mistakeChance",
] as const;

const DEFAULT_CONFIG: HumanConfig = Object.freeze({
  pathPoints: 14,
  pathCurve: 16,
  anchor: [0.35, 0.65] as [number, number],
  pressPause: [45, 120] as [number, number],
  holdTime: [40, 95] as [number, number],
  doubleClickGap: [55, 110] as [number, number],
  keyGap: [70, 160] as [number, number],
  keyHold: [45, 95] as [number, number],
  focusPause: [90, 180] as [number, number],
  wheelNotch: 100,
  wheelPause: [25, 70] as [number, number],
  scrollRounds: 20,
  mistakeChance: 0,
  random: Math.random,
}) as HumanConfig;

const CAREFUL_CONFIG: HumanConfig = Object.freeze({
  ...DEFAULT_CONFIG,
  pathPoints: 22,
  pathCurve: 22,
  pressPause: [90, 200] as [number, number],
  holdTime: [60, 130] as [number, number],
  keyGap: [110, 230] as [number, number],
  keyHold: [60, 120] as [number, number],
  focusPause: [140, 280] as [number, number],
  wheelPause: [45, 110] as [number, number],
}) as HumanConfig;

export const presets: Readonly<Record<HumanPreset, HumanConfig>> = Object.freeze({
  default: DEFAULT_CONFIG,
  careful: CAREFUL_CONFIG,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(
      `[cloakium] humanConfig.${key} must be a finite non-negative number, got ${String(value)}`,
    );
  }
  return value;
}

function assertRange(key: string, value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ConfigurationError(
      `[cloakium] humanConfig.${key} must be a [min, max] pair, got ${JSON.stringify(value)}`,
    );
  }
  const min = assertNumber(`${key}[0]`, value[0]);
  const max = assertNumber(`${key}[1]`, value[1]);
  if (min > max) {
    throw new ConfigurationError(
      `[cloakium] humanConfig.${key} min (${min}) is greater than max (${max})`,
    );
  }
  return [min, max];
}

/** Validate and copy a partial config. Unknown keys are rejected. */
export function validateHumanConfig(overrides: unknown): Partial<HumanConfig> {
  if (overrides === undefined || overrides === null) return {};
  if (!isPlainObject(overrides)) {
    throw new ConfigurationError("[cloakium] humanConfig must be an object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "random") {
      if (typeof value !== "function") {
        throw new ConfigurationError("[cloakium] humanConfig.random must be a function");
      }
      out.random = value;
      continue;
    }
    if ((RANGE_KEYS as readonly string[]).includes(key)) {
      out[key] = assertRange(key, value);
      continue;
    }
    if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      const number = assertNumber(key, value);
      if ((key === "pathPoints" || key === "scrollRounds") && !Number.isInteger(number)) {
        throw new ConfigurationError(`[cloakium] humanConfig.${key} must be an integer`);
      }
      if (key === "wheelNotch" && number <= 0) {
        throw new ConfigurationError("[cloakium] humanConfig.wheelNotch must be greater than 0");
      }
      if (key === "mistakeChance" && number > 1) {
        throw new ConfigurationError("[cloakium] humanConfig.mistakeChance must be between 0 and 1");
      }
      out[key] = number;
      continue;
    }
    throw new ConfigurationError(`[cloakium] unknown humanConfig field ${JSON.stringify(key)}`);
  }
  return out as Partial<HumanConfig>;
}

/** Merge overrides onto a base config (both validated). */
export function mergeConfig(
  base: HumanConfig,
  overrides?: Partial<HumanConfig> | null,
): HumanConfig {
  const validated = validateHumanConfig(overrides ?? undefined);
  const merged: HumanConfig = { ...base, ...validated };
  return Object.freeze(merged) as HumanConfig;
}

/** Resolve a preset plus optional overrides into a complete config. */
export function resolveConfig(
  preset: HumanPreset = "default",
  overrides?: Partial<HumanConfig> | null,
): HumanConfig {
  const base = presets[preset];
  if (base === undefined) {
    throw new ConfigurationError(
      `[cloakium] unknown human preset ${JSON.stringify(preset)}; ` +
        `expected one of ${Object.keys(presets).join(", ")}`,
    );
  }
  return mergeConfig(base, overrides);
}

export function randomIn(range: [number, number], random: () => number): number {
  return range[0] + random() * (range[1] - range[0]);
}

export function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
