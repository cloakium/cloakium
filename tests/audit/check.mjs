#!/usr/bin/env node
/**
 * Aggregate local unit and selfcheck runner for tests/audit.
 *
 * Runs every tests/audit/**\/*.test.mjs (node:test) and the structural
 * selfchecks, sequentially and fail-fast, under one 10-minute wall clock.
 * No browser is launched and no external network is used; loopback fixtures
 * only. The aggregate is not part of `npm test`; the package script calls it
 * explicitly as `test:audit:unit`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BUDGET_MS = 10 * 60 * 1000;
const SKIP_DIRECTORIES = new Set(["node_modules", "target", "artifacts", "reports", "evidence"]);
const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"];
// The browser integration test skips without these; a unit run must not launch.
const BROWSER_TEST_KEYS = [
  "CLOAKIUM_AUDIT_TEST_BINARY", "CLOAKIUM_AUDIT_TEST_CLIENT", "CLOAKIUM_AUDIT_TEST_FONTCONFIG",
];

/**
 * Structural checks. `browser.mjs` is deliberately absent: it launches a real
 * browser. `network/selfcheck/run.mjs` is gated on an OpenSSL CLI because the
 * lab's minimal fixture environment cannot find a Nix store binary by name.
 */
const SELFCHECKS = [
  { name: "browser-contracts", file: "tests/audit/browser-contracts/selfcheck.mjs" },
  { name: "extended-network", file: "tests/audit/extended-network/selfcheck.mjs" },
  { name: "wire-identity", file: "tests/audit/wire-identity/selfcheck.mjs" },
  { name: "network/syntax", file: "tests/audit/network/selfcheck/syntax.mjs" },
  { name: "network/manifest", file: "tests/audit/network/selfcheck/manifest.mjs" },
  { name: "network/profile-fixture", file: "tests/audit/network/selfcheck/profile-fixture.mjs" },
  { name: "network/h3-fixture", file: "tests/audit/network/selfcheck/h3-fixture.mjs" },
  { name: "network/source-guard", file: "tests/audit/network/selfcheck/sources.mjs" },
  { name: "network/lab", file: "tests/audit/network/selfcheck/run.mjs", requires: "openssl" },
  { name: "request-paths/syntax", file: "tests/audit/request-paths/selfcheck/syntax.mjs" },
  { name: "request-paths/lab", file: "tests/audit/request-paths/selfcheck/run.mjs" },
];

function parseArguments(argv) {
  const options = { list: false, verbose: false, budgetMs: BUDGET_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--list") options.list = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--timeout-ms") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1000)
        throw new Error("--timeout-ms needs an integer of at least 1000");
      options.budgetMs = Math.min(value, BUDGET_MS);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

function usage() {
  return [
    "usage: node tests/audit/check.mjs [--list] [--verbose] [--timeout-ms N] [--help]",
    "",
    "Local audit units: every tests/audit/**/*.test.mjs (node:test) plus the",
    "structural selfchecks, run sequentially and fail-fast.",
    "",
    "  --list        print the planned commands without executing them",
    "  --verbose     print each child's full stdout and stderr",
    "  --timeout-ms  whole-command wall clock, capped at 600000 (10 minutes)",
    "",
    "No browser is launched and no external network is used. The H3 fixture",
    "self-skips unless CLOAKIUM_H3_BIN or a built tools/audit-h3-lab target",
    "exists. The network lab selfcheck needs OPENSSL_BIN or openssl on PATH.",
  ].join("\n");
}

function discoverTests(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discoverTests(absolute, found);
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(absolute);
  }
  return found;
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function resolveOpenssl() {
  if (process.env.OPENSSL_BIN && existsSync(process.env.OPENSSL_BIN)) return process.env.OPENSSL_BIN;
  return findExecutable("openssl");
}

function plan() {
  const commands = discoverTests(HERE).map((file) => ({
    kind: "test", name: path.relative(ROOT, file), file,
  }));
  const openssl = resolveOpenssl();
  for (const entry of SELFCHECKS) {
    const file = path.join(ROOT, entry.file);
    if (!existsSync(file))
      throw new Error(`selfcheck contract is missing: ${entry.file}`);
    const command = { kind: "selfcheck", name: entry.name, file, env: {} };
    if (entry.requires === "openssl") {
      if (!openssl) command.skip = "no OpenSSL CLI (set OPENSSL_BIN)";
      else command.env.OPENSSL_BIN = openssl;
    }
    commands.push(command);
  }
  return commands;
}

function childEnvironment(command) {
  const env = { ...process.env, ...command.env };
  for (const key of DISPLAY_KEYS) delete env[key];
  for (const key of BROWSER_TEST_KEYS) delete env[key];
  return env;
}

function integerField(lines, pattern) {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function summarize(stdout) {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const tests = integerField(lines, /^(?:ℹ|#) tests (\d+)$/);
  const pass = integerField(lines, /^(?:ℹ|#) pass (\d+)$/);
  if (tests !== null || pass !== null) {
    const fail = integerField(lines, /^(?:ℹ|#) fail (\d+)$/) ?? 0;
    return `tests ${tests ?? "?"} pass ${pass ?? "?"} fail ${fail}`;
  }
  if (stdout.trimStart().startsWith("{")) {
    try {
      const value = JSON.parse(stdout);
      if (Number.isInteger(value.ok)) return `findings ${value.ok}`;
    } catch {}
  }
  const summary = [...lines].reverse().find((line) =>
    line.length <= 200 && /(selfcheck|source guard|checks|passed)/i.test(line));
  return summary ?? (lines.at(-1)?.slice(0, 200) ?? "ok");
}

function printFailure(command, result, milliseconds) {
  const status = result.status ?? result.signal ?? "unknown";
  console.error(`FAIL ${command.name} (${milliseconds}ms, exit ${status})`);
  if (result.error) console.error(`  ${result.error.message}`);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const lines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines.slice(-30)) console.error(`  ${line.slice(0, 400)}`);
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let commands;
  try {
    commands = plan();
  } catch (error) {
    console.error(`audit units: ${error.message}`);
    return 1;
  }
  const skipped = commands.filter((command) => command.skip).length;
  if (options.list) {
    for (const command of commands) {
      const suffix = command.skip ? ` :: ${command.skip}` : "";
      console.log(`${command.kind === "test" ? "test" : "selfcheck"} ${path.relative(ROOT, command.file)}${suffix}`);
    }
    console.log(`\n${commands.length} commands, ${skipped} skipped, budget ${options.budgetMs}ms`);
    return 0;
  }

  const started = Date.now();
  const deadline = started + options.budgetMs;
  let completed = 0;
  for (const command of commands) {
    if (command.skip) {
      console.log(`skip ${command.name} :: ${command.skip}`);
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error(`FAIL ${command.name} (wall clock budget ${options.budgetMs}ms exhausted)`);
      return 1;
    }
    const begin = Date.now();
    const result = spawnSync(process.execPath, [command.file], {
      cwd: ROOT,
      env: childEnvironment(command),
      encoding: "utf8",
      timeout: remaining,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const milliseconds = Date.now() - begin;
    const timedOut = result.error?.code === "ETIMEDOUT";
    if (timedOut || result.status !== 0) {
      printFailure(command, result, milliseconds);
      console.error(`\naudit units: stopped at ${command.name}; ${completed} passed, ${skipped} skipped`);
      return 1;
    }
    completed += 1;
    console.log(`ok ${command.name} (${milliseconds}ms) — ${summarize(result.stdout ?? "")}`);
    if (options.verbose) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
  console.log(`\naudit units: ${completed} commands passed, ${skipped} skipped in ${Date.now() - started}ms`);
  return 0;
}

process.exitCode = main();
