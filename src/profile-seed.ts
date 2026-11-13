/**
 * Per-profile fingerprint seed persistence.
 *
 * Two files are recognised:
 *   - `.cloakbrowser-seed` — legacy profile marker, read-only here so existing
 *     profiles keep their identity;
 *   - `.cloakium-seed` — written by this package.
 *
 * The seed is derived deterministically from the profile path before anything
 * is written, so two processes starting against the same profile agree on the
 * identity even if they race on file creation. The file is published with
 * `link(2)` (or an exclusive create where hard links are unavailable), so a
 * racing writer can never overwrite an existing identity.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SEED_MAX, SEED_MIN, seedForProfile } from "./config.js";

export const LEGACY_SEED_FILE = ".cloakbrowser-seed";
export const SEED_FILE = ".cloakium-seed";

const SEED_PATTERN = /^\d{5}$/;

export function isValidSeed(value: number): boolean {
  return Number.isInteger(value) && value >= SEED_MIN && value <= SEED_MAX;
}

function parseSeed(text: string): number | null {
  const trimmed = text.trim();
  if (!SEED_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return isValidSeed(value) ? value : null;
}

/** Read a seed file; `null` when missing, empty, or unparsable. */
export function readSeedFile(file: string): number | null {
  try {
    return parseSeed(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function publish(file: string, seed: number): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${seed}\n`, { mode: 0o600 });
  try {
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          fs.writeFileSync(file, `${seed}\n`, { flag: "wx", mode: 0o600 });
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner;
        }
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* already gone */
    }
  }
}

function stableProfileKey(userDataDir: string): string {
  const absolute = path.resolve(userDataDir);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** The seed a profile has, or would be given, without writing anything. */
export function profileSeed(userDataDir: string): number {
  const legacy = readSeedFile(path.join(userDataDir, LEGACY_SEED_FILE));
  if (legacy !== null) return legacy;
  const current = readSeedFile(path.join(userDataDir, SEED_FILE));
  if (current !== null) return current;
  return seedForProfile(stableProfileKey(userDataDir));
}

/**
 * Prepend the profile's seed switch to `args`, creating the seed file when this
 * is the first launch. An explicit `--fingerprint` in `args`, or
 * `stealthArgs: false`, leaves the profile untouched.
 */
export function applyProfileSeed(
  userDataDir: string | undefined,
  stealthArgs: boolean | undefined,
  args: string[] | undefined,
): string[] | undefined {
  if (!userDataDir || stealthArgs === false) return args;
  if ((args ?? []).some((arg) => arg.split("=")[0] === "--fingerprint")) return args;

  const legacyPath = path.join(userDataDir, LEGACY_SEED_FILE);
  const seedPath = path.join(userDataDir, SEED_FILE);

  const legacy = readSeedFile(legacyPath);
  if (legacy !== null) return [`--fingerprint=${legacy}`, ...(args ?? [])];

  let seed = readSeedFile(seedPath);
  if (seed === null) {
    seed = seedForProfile(stableProfileKey(userDataDir));
    publish(seedPath, seed);
    const written = readSeedFile(seedPath);
    if (written !== null) seed = written;
  }
  return [`--fingerprint=${seed}`, ...(args ?? [])];
}
