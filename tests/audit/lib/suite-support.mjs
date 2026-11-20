// Pure helpers shared by the suite executor and persistent-context execution:
// row shaping, launch evidence, context-option merging and positive-control
// linkage. No I/O beyond closing a fixture lab.

import { hashValue } from './hashes.mjs';
import { bounded, summarizeResult } from './outcomes.mjs';
import { safeError } from './secure-io.mjs';
import { createProfileExportFixture } from '../profile-lifecycle/lib/export-fixture.mjs';

const CREDENTIAL_URL = /(?:https?|socks5h?):\/\/[^/\s:@]+:[^/\s@]+@/i;
const CREDENTIAL_FLAG = /^--(?:license|licence|api[-_]?key|token|password|secret|bearer)(?:=|$)/i;

/** Only `--flag` names are recorded; positional values never reach evidence. */
export function argumentNames(args) {
  return args.map((argument) => {
    const text = String(argument);
    if (!text.startsWith('--')) return '[positional]';
    const separator = text.indexOf('=');
    return separator === -1 ? text : text.slice(0, separator);
  });
}

/** Caller baseline arguments may not carry credentials; suite fixtures may. */
export function assertSafeBaseArgs(args) {
  for (const argument of args) {
    if (typeof argument !== 'string') throw new Error('baseArgs must be strings');
    if (CREDENTIAL_URL.test(argument)) throw new Error('baseArgs must not contain credentialed URLs');
    if (CREDENTIAL_FLAG.test(argument)) throw new Error('baseArgs must not contain credential-like flags');
  }
  return args;
}

/** Caller ignore-list merged with the scenario's own list, de-duplicated. */
export function effectiveIgnoreDefaultArgs(additional, scenarioArgs = []) {
  if (additional === undefined || additional === null) return [...scenarioArgs];
  if (typeof additional === 'boolean') {
    throw new Error('probeConfig.ignoreDefaultArgs must be an array of "--flag" strings');
  }
  if (!Array.isArray(additional) || additional.some((arg) => typeof arg !== 'string' || !arg.startsWith('--'))) {
    throw new Error('probeConfig.ignoreDefaultArgs must be an array of "--flag" strings');
  }
  return [...new Set([...scenarioArgs, ...additional])];
}

export function launchRecord(args, ignoreDefaultArgs, contextOptions, overrides = []) {
  return {
    argsSha256: hashValue({ args, ignoreDefaultArgs, contextOptions }),
    argumentNames: argumentNames(args),
    ignoreDefaultArgs: [...ignoreDefaultArgs],
    contextOptions: { ...contextOptions },
    overrides: [...overrides]
  };
}

/** A previous probe is a positive control only when every check is a known pass. */
export function priorVerdict(counts) {
  if (!counts) return 'unknown';
  if ((counts.fail ?? 0) > 0) return 'fail';
  if ((counts.pass ?? 0) > 0 && (counts.unknown ?? 0) === 0) return 'pass';
  return 'unknown';
}

/** Explicit caller prior results win; earlier rows only fill missing ids. */
export function mergePriorResults(explicit, entries) {
  const merged = { ...(explicit ?? {}) };
  for (const entry of entries) {
    if (Object.hasOwn(merged, entry.id)) continue;
    merged[entry.id] = priorVerdict(entry.counts);
  }
  return merged;
}

/** Validate the runner-owned shared probe origin handle (probe-kind suites only). */
export function assertSharedProbeLab(fixture) {
  if (!fixture || typeof fixture !== 'object') throw new Error('sharedProbeLab must be an object');
  for (const key of ['origin', 'crossOrigin']) {
    if (typeof fixture[key] !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(fixture[key])) {
      throw new Error(`sharedProbeLab.${key} must be a loopback HTTP origin`);
    }
  }
  if (!Number.isInteger(fixture.port) || fixture.port <= 0) throw new Error('sharedProbeLab.port must be the actual bound port');
  return fixture;
}

/** Evidence recorded on every session: the actual origin a probe observed. */
export function fixtureDiagnostics(lab, { borrowed = false } = {}) {
  return {
    origin: lab?.origin ?? null,
    crossOrigin: lab?.crossOrigin ?? null,
    port: Number.isInteger(lab?.port) ? lab.port : null,
    ownership: borrowed ? 'borrowed-owned-runner' : 'suite-owned-fresh',
    ...(borrowed && lab?.receipt?.sha256 ? { sha256: lab.receipt.sha256 } : {})
  };
}

export function mergeContextOptions(environment, configuration, scenario, probe) {
  const options = { viewport: null, locale: environment.locale, timezoneId: environment.timezoneId };
  const overrides = [];
  for (const layer of [configuration.contextOptions, scenario?.contextOptions, probe.contextOptions]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (Object.hasOwn(options, key) && JSON.stringify(options[key]) !== JSON.stringify(value)) overrides.push(key);
      options[key] = value;
    }
  }
  return { options, overrides };
}

/** Start only the fixtures a scenario's probes actually need. */
export function labOptionsFor(probeIds) {
  const ids = probeIds ?? [];
  const http2 = ids.includes('net.tls.http2-negotiation');
  return {
    tls: http2,
    http2,
    h3: ids.some((id) => id.startsWith('net.h3.')),
    doh: ids.includes('net.doh.resolution'),
    transparentProxy: ids.includes('net.proxy.transparent-form')
  };
}

export function unavailableRow(base, reason) {
  return {
    ...base,
    status: 'unavailable',
    result: {
      observations: {},
      checks: [{ name: `${base.id}/run`, passed: null, status: 'stage-needed', detail: reason }],
      limitations: [{ code: 'suite-not-run', detail: reason }]
    },
    counts: { pass: 0, fail: 0, unknown: 1 }
  };
}

export function errorRow(base, error, operation) {
  return {
    ...base,
    status: 'execution-error',
    result: {
      observations: {},
      checks: [{ name: `${base.id}/run`, passed: null, status: 'inconclusive' }],
      limitations: [{ code: 'execution-error', detail: 'Probe execution failed; see error record.' }]
    },
    counts: { pass: 0, fail: 0, unknown: 1 },
    error: error?.auditError ?? safeError(error, operation)
  };
}

export async function closeLab(lab) {
  if (!lab) return { closed: true, errors: [] };
  try {
    const receipt = await lab.close();
    return { closed: receipt?.closed !== false, errors: receipt?.errors ?? [] };
  } catch (error) {
    return { closed: false, errors: [safeError(error, 'lab close')] };
  }
}

/**
 * Static caller-profile scenario: build the closed-profile export fixture with the
 * same browser executable/mode/context/environment, run the static security probe,
 * then remove only the fixture's own marked directories. The canary VALUE is never
 * copied into the row or session; only the helper receipt metadata is kept.
 */
export async function runStaticExportScenario({
  suiteId, scenarioId, probe, plan, options, configuration, environment, target,
  launchEnv, baseArgs, output, signal, emit, sessions, errors, dependencies = {},
  ignoreDefaultArgs = [], lab = null
}) {
  const fixtureFactory = dependencies.exportFixtureFactory ?? createProfileExportFixture;
  const started = new Date().toISOString();
  const base = { id: probe.id, family: probe.family, suiteId, scenarioId, started };
  const contextOptions = { locale: environment.locale, timezoneId: environment.timezoneId };
  let fixture = null;
  let receipt = null;
  let result = null;
  let failure = null;
  let cleanupError = null;
  try {
    fixture = await fixtureFactory({
      chromium: options.chromium,
      target: { executablePath: target.executablePath },
      configuration: {
        mode: configuration.mode,
        contextOptions,
        probeConfig: { ...(configuration.probeConfig ?? {}), ignoreDefaultArgs }
      },
      environment: contextOptions,
      output,
      launchEnv,
      baseArgs,
      signal,
      dependencies: dependencies.exportFixtureDependencies ?? {}
    });
    receipt = fixture.receipt;
    result = await bounded(() => probe.run(fixture.inputs), 210_000, probe.id);
  } catch (error) {
    failure = error;
  } finally {
    if (fixture) {
      try {
        const closed = await fixture.close({ remove: true });
        if (closed) receipt = closed;
      } catch (error) {
        cleanupError = safeError(error, 'export fixture close');
      }
    }
  }

  const cleanupOk = Boolean(receipt)
    && receipt.cleanup?.unknown === false
    && receipt.cleanup?.after === 0
    && !cleanupError;
  const versions = Array.isArray(receipt?.browserVersions) ? receipt.browserVersions.filter((value) => typeof value === 'string' && value.length > 0) : [];
  const version = versions.length === 1 ? versions[0] : null;

  let row;
  if (failure) {
    row = errorRow(base, failure, 'caller-profile fixture');
  } else {
    const summary = summarizeResult(result);
    row = { ...base, status: summary.status, result, counts: summary.counts };
  }
  row.version = version;
  row.environment = { requested: contextOptions };
  row.transport = 'static-profile-export-fixture';
  row.processVerification = cleanupOk ? 'fixture-owned-lease-verified' : 'unknown';
  row.fixture = receipt
    ? {
      schema: receipt.schema,
      policy: receipt.policy,
      generated: receipt.generated,
      platform: receipt.platform,
      mode: receipt.mode,
      browserVersions: versions,
      profileCount: receipt.profileCount,
      portableFlag: receipt.portableFlag,
      canary: receipt.canary,
      seeded: receipt.seeded,
      restart: receipt.restart,
      cleanup: receipt.cleanup,
      contextOptions: receipt.contextOptions,
      limitations: receipt.limitations
    }
    : null;
  row.cleanup = cleanupOk
    ? { closed: true, ...(receipt?.cleanup ?? {}) }
    : { closed: false, ...(receipt?.cleanup ?? {}), ...(cleanupError ? { error: cleanupError } : {}) };
  row.finished = new Date().toISOString();
  await emit(row);

  sessions.push({
    suiteId,
    scenarioId,
    transport: 'static-profile-export-fixture',
    version,
    browserVersions: versions,
    diagnostics: { fixture: fixtureDiagnostics(lab) },
    environment: { requested: contextOptions },
    sandbox: null,
    launch: {
      ...launchRecord(baseArgs, ignoreDefaultArgs, contextOptions),
      portableFlag: receipt?.portableFlag ?? null
    },
    socketWitness: { available: false, absenceEstablished: false, reason: 'not-a-browser-server' },
    fixture: row.fixture,
    cleanup: { closed: cleanupOk, ...(receipt?.cleanup ?? {}), processVerification: row.processVerification }
  });

  if (!cleanupOk || failure) {
    errors.push({
      scope: 'export-fixture',
      scenarioId,
      error: row.error ?? cleanupError ?? {
        operation: 'export fixture',
        category: 'cleanup-unknown',
        detail: 'The export fixture did not report a clean, verified close.'
      }
    });
    return { aborted: true };
  }
  return { aborted: false };
}
