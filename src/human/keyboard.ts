/**
 * Keyboard input through Playwright's real key pipeline: `down`/`up` for keys
 * that exist, `insertText` where no physical key produces the character.
 */

import type { Page } from "playwright-core";

import { randomIn, type HumanConfig } from "./config.js";
import type { Deadline } from "./deadline.js";

/** QWERTY neighbours for optional typo simulation. */
const NEIGHBOURS: Readonly<Record<string, string>> = Object.freeze({
  a: "sqzw",
  b: "vgnh",
  c: "xdfv",
  d: "sfec",
  e: "wrsd",
  f: "dgrt",
  g: "fhty",
  h: "gjyu",
  i: "uojk",
  j: "hkun",
  k: "jlim",
  l: "kop",
  m: "njk",
  n: "bhjm",
  o: "ipkl",
  p: "ol",
  q: "wa",
  r: "etdf",
  s: "adwx",
  t: "ryfg",
  u: "yihj",
  v: "cbfg",
  w: "qeas",
  x: "zsdc",
  y: "tugh",
  z: "asx",
});

function neighbour(ch: string, random: () => number): string | undefined {
  const options = NEIGHBOURS[ch.toLowerCase()];
  if (options === undefined) return undefined;
  const pick = options[Math.floor(random() * options.length)] ?? options[0];
  return ch === ch.toUpperCase() ? pick.toUpperCase() : pick;
}

function isAscii(ch: string): boolean {
  return ch.codePointAt(0)! < 128;
}

async function typeCharacter(
  page: Page,
  ch: string,
  cfg: HumanConfig,
  deadline: Deadline,
  api: string,
): Promise<void> {
  if (!isAscii(ch)) {
    // No physical key produces this character; insert it like an IME would.
    await page.keyboard.insertText(ch);
    return;
  }
  await page.keyboard.down(ch);
  try {
    await deadline.pause(randomIn(cfg.keyHold, cfg.random), api, "the key to be released");
  } finally {
    await page.keyboard.up(ch).catch(() => undefined);
  }
}

/** Type `text` with per-key timing inside the action's budget. */
export async function typeText(
  page: Page,
  text: string,
  cfg: HumanConfig,
  deadline: Deadline,
  delay: number | undefined,
  api = "humanize.type",
): Promise<void> {
  for (const ch of [...text]) {
    if (deadline.expired()) throw deadline.error(api, "the field to accept input");

    if (cfg.mistakeChance > 0 && cfg.random() < cfg.mistakeChance) {
      const wrong = neighbour(ch, cfg.random);
      if (wrong !== undefined) {
        await typeCharacter(page, wrong, cfg, deadline, api);
        await deadline.pause(60 + cfg.random() * 120, api, "the typo to be noticed");
        await page.keyboard.press("Backspace", {
          delay: deadline.cap(randomIn(cfg.keyHold, cfg.random)),
        });
        await deadline.pause(40 + cfg.random() * 80, api, "the correction");
      }
    }

    await typeCharacter(page, ch, cfg, deadline, api);
    await deadline.pause(delay ?? randomIn(cfg.keyGap, cfg.random), api, "the next character");
  }
}

/** Press one key with a human hold time. */
export async function pressKey(
  page: Page,
  key: string,
  cfg: HumanConfig,
  deadline: Deadline,
  delay: number | undefined,
  api = "humanize.press",
): Promise<void> {
  if (deadline.expired()) throw deadline.error(api, "the key press");
  await page.keyboard.press(key, {
    delay: deadline.cap(delay ?? randomIn(cfg.keyHold, cfg.random)),
  });
}

/** Select the field's contents (`ControlOrMeta` is Windows/Linux and macOS). */
export async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+A");
}

/** Clear a focused field. */
export async function clearField(
  page: Page,
  cfg: HumanConfig,
  deadline: Deadline,
  api = "humanize.clear",
): Promise<void> {
  await selectAll(page);
  await deadline.pause(randomIn(cfg.keyHold, cfg.random), api, "the selection");
  await pressKey(page, "Backspace", cfg, deadline, undefined, api);
}
