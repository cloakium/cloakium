// Machine-readable suite manifest: ids, families, budgets, required context,
// declared checks, unsupported states and the harness/config mapping.
//
// Derived from the descriptors so it cannot drift. `probes[]` is the
// machine-readable form a harness consumes directly.

import { families, MAX_PROBE_TIMEOUT_MS, probes } from './index.mjs';
import { comparison, configRows, optionalChecks, outOfScope } from './mapping.mjs';
import { limitCodes, mapProbeSources } from './support/scan.mjs';

const sources = mapProbeSources(probes);

export const contextDefaults = {
  viewport: null,
  locale: 'harness default (no override required)',
  timezoneId: 'harness default (no override required)',
  javaScriptEnabled: true,
  permissions: [],
  note: 'No probe requires a locale or timezone override. Any per-probe need is declared in the probe contract as contextOptions; every probe currently declares {}.'
};

const suiteMaxMs = probes.reduce((total, probe) => total + probe.timeoutMs, 0);

export const budgets = {
  perProbeDefaultMs: 15_000,
  perProbeMaxMs: MAX_PROBE_TIMEOUT_MS,
  suiteMaxMs,
  recommendedGlobalMs: suiteMaxMs + 30_000,
  note: 'suiteMaxMs is the worst case (every probe hitting its own bound); recommendedGlobalMs adds 30s for context creation and teardown.'
};

export const manifest = {
  schemaVersion: 2,
  suite: 'cloakium-independent-fingerprint-probes',
  purpose:
    'Original behavioural probes authored from public Web API documentation and this repository’s public tests. They describe required coherence/determinism properties, not implementation details.',
  revision: '2026-11-20',
  target: {
    selectedBy: 'the harness: whichever browser executable the caller supplies',
    note: 'Probes never read binaries, decompiler output, internal tables or props. Only public browser APIs are exercised.'
  },
  families,
  budgets,
  contextDefaults,
  outOfScope,
  harnessContract: {
    runSignature:
      'async run({ page, context, browser, origin, crossOrigin, lab, config, deadline })',
    descriptor: 'export const probes = [{ id, family, timeoutMs, contextOptions, contract, run }]',
    result:
      '{ observations, checks: [{ name, passed: true|false|null, detail? }], limitations: [{ code, detail? }], coverage: "full"|"partial"|"unknown", failed }',
    verdictPolicy:
      'passed === null means not evaluable on this host. It must never be counted as a pass. coverage === "unknown" means no surface was exercised. Any passed === false is a real defect in every config row.',
    timeoutPolicy: `Each descriptor exposes timeoutMs (hard maximum ${MAX_PROBE_TIMEOUT_MS} ms; currently all <= 20000). run() also honours an earlier caller-supplied \`deadline\` (epoch ms) and rejects with ProbeDeadlineError (code "deadline-exceeded"), which the harness should record as not-run/unknown rather than a check failure.`,
    comparisonPolicy:
      'Diff `observations` using mapping.mjs: mustBeEqualAcrossModes / mustBeEqualAcrossSeeds must be identical; mayVaryAcrossSeeds and mayVaryAcrossConfig are shape comparisons only. Never assert a seed-sensitive value equals a fixed constant.',
    requiredContext:
      'A real browser context with a loopback origin serving a document at `/`, and a second loopback alias (`localhost` versus `127.0.0.1`) for origin-scope. Contexts are created per probe with viewport:null; locale/timezone are harness defaults.',
    contextOptions: 'Read `probe.contextOptions` (currently {}) and merge it into newContext.'
  },
  configRows,
  comparisonLegend: comparison.legend,
  probes: probes.map((probe) => {
    const source = sources.get(probe.id);
    return {
      id: probe.id,
      family: probe.family,
      timeoutMs: probe.timeoutMs,
      contextOptions: probe.contextOptions,
      module: source ? source.file.slice(source.file.indexOf('/fingerprint/') + '/fingerprint/'.length) : null,
      context: probe.contract,
      checks: probe.contract.checks,
      optionalChecks: optionalChecks[probe.id] ?? [],
      comparison: comparison.probes[probe.id] ?? null,
      unsupportedStates: source ? limitCodes(source.source) : []
    };
  })
};

export const probeIds = probes.map((probe) => probe.id);
