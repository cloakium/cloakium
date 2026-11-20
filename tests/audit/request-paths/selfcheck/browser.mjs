/**
 * Optional headless smoke against an explicitly supplied Chromium build
 * (`--executable-path`). Never adds --no-sandbox and never weakens TLS.
 * Prints observations only: it makes no pass claim of its own.
 */
import { pathToFileURL } from "node:url";
import { startLab } from "../lab.mjs";
import { scenarios, scenarioLaunch, configForScenario } from "../scenarios.mjs";
import { probes } from "../probes/index.mjs";

const args = process.argv.slice(2);
const options = Object.fromEntries(
  args.reduce((rows, item, index, values) => {
    if (index % 2 === 0) rows.push([item, values[index + 1]]);
    return rows;
  }, []),
);

const executablePath = options["--executable-path"];
const playwrightIndex = options["--playwright"];
if (!executablePath || !playwrightIndex) {
  console.error("usage: node selfcheck/browser.mjs --executable-path ABS --playwright ABS_INDEX_MJS [--scenario ID]");
  process.exit(2);
}

const { chromium } = await import(pathToFileURL(playwrightIndex).href);

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const selected = options["--scenario"]
  ? scenarios.filter((entry) => entry.id === options["--scenario"])
  : scenarios;

const lab = await startLab();
const output = [];
try {
  for (const scenario of selected) {
    const plan = scenarioLaunch(scenario.id, lab);
    if (!plan || plan.skipReason) {
      output.push({ scenario: scenario.id, skipped: plan?.skipReason ?? "unknown scenario" });
      continue;
    }
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: true,
      timeout: 60_000,
      args: plan.launch.args,
      ignoreDefaultArgs: plan.launch.ignoreDefaultArgs,
      ...(plan.launch.proxy ? { proxy: plan.launch.proxy } : {}),
    });
    const rows = [];
    try {
      const config = configForScenario(plan);
      for (const probe of probes.filter((entry) => plan.probes.includes(entry.id))) {
        const context = await browser.newContext({
          viewport: null,
          ...plan.contextOptions,
          ...(plan.launch.proxy ? { proxy: plan.launch.proxy } : {}),
        });
        try {
          const page = await context.newPage();
          const budget = Math.min(probe.timeoutMs, 45_000);
          const result = await deadline(
            Promise.resolve().then(() =>
              probe.run({
                page,
                context,
                browser,
                origin: lab.origin,
                crossOrigin: lab.crossOrigin,
                lab,
                config,
                deadline: Date.now() + budget,
              }),
            ),
            budget,
            probe.id,
          );
          rows.push({
            id: probe.id,
            reportStatus: result.status,
            checks: result.checks.map((check) => ({ name: check.name, passed: check.passed, status: check.status ?? null })),
            taxonomy: result.observations?.taxonomy ?? null,
            proxyDelta: result.observations?.proxyDelta ?? null,
            error: result.observations?.error ?? null,
            routeHit: result.observations?.routeHit ?? null,
            limitations: result.limitations.length,
          });
        } finally {
          await deadline(context.close(), 15_000, `${probe.id}: context close`).catch(() => {});
        }
      }
    } finally {
      await deadline(browser.close(), 20_000, "browser close").catch(() => {});
    }
    output.push({ scenario: scenario.id, route: plan.proxyRoute, probes: rows });
  }
} finally {
  await lab.close();
}

console.log(JSON.stringify({ executablePath, headless: true, output }, null, 2));
