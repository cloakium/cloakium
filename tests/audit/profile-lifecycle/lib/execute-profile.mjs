// Persistent-context execution: the profile suite has no BrowserServer, so the
// parent child lease supplies process ownership evidence. The lease excludes the
// Node parent and every pre-existing fixture; only new descendants are tracked,
// and only those are ever signalled (pid+startTicks guarded).

import { summarizeResult } from '../../lib/outcomes.mjs';
import { createChildLease } from '../../lib/processes.mjs';
import { safeError } from '../../lib/secure-io.mjs';
import { launchRecord } from '../../lib/suite-support.mjs';
import { IGNORED_DEFAULT_ARGS } from './lab.mjs';

const LEASE_WAIT_MS = 3_000;
const LEASE_KILL_WAIT_MS = 1_500;

export function profileSelection(suite, requested) {
  if (requested === undefined) return [...suite.scenarioIds];
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('profile scenario ids must be a non-empty array');
  const unknown = requested.filter((id) => !suite.scenarioIds.includes(id));
  if (unknown.length) throw new Error(`Unknown profile scenario id(s): ${unknown.join(', ')}`);
  return [...requested];
}

function unavailableRow(base, reason) {
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

function errorRow(base, entry) {
  return {
    ...base,
    status: 'execution-error',
    result: {
      observations: {},
      checks: [{ name: `${base.id}/run`, passed: null, status: 'inconclusive' }],
      limitations: [{ code: 'execution-error', detail: 'Scenario execution failed; see error record.' }]
    },
    counts: { pass: 0, fail: 0, unknown: 1 },
    error: entry.error ?? { operation: `${base.id} run`, category: 'operation-failed' }
  };
}

function wrapChromiumForLease(chromium, lease) {
  const sample = async () => {
    try {
      await lease.sample();
    } catch {
      /* the lease reports its own limitations */
    }
  };
  return new Proxy(chromium, {
    get(target, property) {
      if (property === 'launchPersistentContext') {
        const original = target[property].bind(target);
        return async (...args) => {
          try {
            return await original(...args);
          } finally {
            // Sample as soon as the context exists (or the launch failed) so the
            // lease sees the persistent Chrome descendants while they are alive.
            await sample();
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function verifyLease(lease) {
  const processTree = {
    method: 'public-node-parent-ancestry',
    verified: false,
    ownedInstances: 0,
    remaining: [],
    limitations: []
  };
  try {
    const sample = await lease.sample();
    let remaining = await lease.waitGone(LEASE_WAIT_MS);
    if (remaining.some((row) => row.verification === 'same-instance')) {
      await lease.terminate('SIGTERM');
      remaining = await lease.waitGone(LEASE_KILL_WAIT_MS);
    }
    if (remaining.some((row) => row.verification === 'same-instance')) {
      await lease.terminate('SIGKILL');
      remaining = await lease.waitGone(LEASE_KILL_WAIT_MS);
    }
    processTree.verified = remaining.length === 0 && lease.limitations.length === 0;
    processTree.ownedInstances = sample.identities.length;
    processTree.remaining = remaining;
    processTree.limitations = lease.limitations;
  } catch (error) {
    processTree.limitations = [`Lease verification failed: ${safeError(error, 'process lease verify').category}`];
  }
  return processTree;
}

export async function executeProfile(context) {
  const { suite, options, dependencies, observations, sessions, errors } = context;
  const { configuration, environment, target, baseArgs, launchEnv, output, signal, onObservation } = options;
  const selected = profileSelection(suite, options.scenarioIds ?? options.probeIds);
  const leaseFactory = dependencies.childLease ?? createChildLease;
  const runner = dependencies.runScenarios ?? suite.runScenarios;

  let lease = null;
  let leaseError = null;
  try {
    lease = await leaseFactory();
  } catch (error) {
    leaseError = safeError(error, 'process lease');
    errors.push({ scope: 'process-lease', error: leaseError });
  }

  const chromium = lease ? wrapChromiumForLease(options.chromium, lease) : options.chromium;
  const profileOutput = `${output}/profile-lifecycle`;
  let report = null;
  let runError = null;
  try {
    report = await runner({
      chromium,
      executablePath: target.executablePath,
      headless: configuration.mode === 'headless',
      baseArgs,
      baseEnv: launchEnv,
      contextOptions: {
        locale: environment.locale,
        timezoneId: environment.timezoneId
      },
      ignoreDefaultArgs: configuration.probeConfig?.ignoreDefaultArgs,
      output: profileOutput,
      scenarios: selected,
      signal,
      log: () => {}
    });
  } catch (error) {
    runError = safeError(error, 'profile run');
    errors.push({ scope: 'profile-run', error: runError });
  }

  const processTree = lease ? await verifyLease(lease) : {
    method: 'public-node-parent-ancestry', verified: false, ownedInstances: 0,
    remaining: [], limitations: ['No process lease was available for this run.']
  };
  const versions = Array.isArray(report?.browserVersions)
    ? report.browserVersions.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const version = versions.length === 1 ? versions[0] : null;
  const callerIgnoreDefaults = Array.isArray(configuration.probeConfig?.ignoreDefaultArgs)
    ? configuration.probeConfig.ignoreDefaultArgs
    : [];
  const effectiveDefaults = [...new Set([...IGNORED_DEFAULT_ARGS, ...callerIgnoreDefaults])];
  const contextOptions = { locale: environment.locale, timezoneId: environment.timezoneId };

  for (const entry of report?.scenarios ?? []) {
    const base = {
      id: entry.id,
      family: 'profile-lifecycle',
      suiteId: suite.id,
      scenarioId: entry.id,
      started: entry.started ?? report?.started ?? null
    };
    let row;
    if (entry.status === 'skipped') {
      row = unavailableRow(base, entry.limitations?.[0]?.detail ?? 'not-run');
    } else if (entry.status === 'execution-error') {
      row = errorRow(base, entry);
    } else {
      const result = {
        observations: entry.observations ?? {},
        checks: entry.checks ?? [],
        limitations: entry.limitations ?? []
      };
      const summary = summarizeResult(result);
      row = { ...base, status: summary.status, result, counts: summary.counts };
    }
    row.version = version;
    row.environment = null;
    row.transport = 'playwright-persistent-context';
    row.processVerification = processTree.verified ? 'verified-by-node-parent-ancestry-lease' : 'unknown';
    row.finished = entry.finished ?? null;
    observations.push(row);
    sessions.push({
      suiteId: suite.id,
      scenarioId: entry.id,
      transport: 'playwright-persistent-context',
      processOwnership: 'parent-owned-proc-tree',
      diagnostics: {
        fixture: { origin: null, crossOrigin: null, port: null, ownership: 'profile-suite-own-server' }
      },
      version,
      browserVersions: versions,
      versionSource: versions.length ? 'lab.launches' : 'unknown',
      environment: { requested: environment ?? null },
      sandbox: null,
      launch: {
        ...launchRecord(baseArgs, effectiveDefaults, contextOptions),
        persistentDriverDefaults: [...IGNORED_DEFAULT_ARGS],
        callerAdditionalIgnoreArgs: [...callerIgnoreDefaults]
      },
      cleanup: {
        contextsClosed: report?.cleanup?.contextsClosed ?? 0,
        activeProfiles: report?.cleanup?.activeProfiles ?? null,
        failedCleanup: report?.cleanup?.failedCleanup ?? true,
        processVerification: row.processVerification,
        processTree
      }
    });
    if (onObservation) {
      try {
        await onObservation(row);
      } catch (error) {
        errors.push({ scope: 'on-observation', scenarioId: entry.id, error: safeError(error, 'observation callback') });
        break;
      }
    }
  }

  const profileCleanup = report?.cleanup ?? {
    contextsOpened: 0, contextsClosed: 0, activeProfiles: null, failedCleanup: true,
    processVerification: 'not-exposed-by-public-persistent-context-api', limitations: []
  };
  const closed = profileCleanup.activeProfiles === 0
    && profileCleanup.failedCleanup === false
    && processTree.verified === true;
  return {
    cleanup: {
      suiteId: suite.id,
      transport: 'playwright-persistent-context',
      closed,
      contextsOpened: profileCleanup.contextsOpened,
      contextsClosed: profileCleanup.contextsClosed,
      activeProfiles: profileCleanup.activeProfiles,
      failedCleanup: profileCleanup.failedCleanup,
      processVerification: processTree.verified ? 'verified-by-node-parent-ancestry-lease' : 'unknown',
      processTree,
      limitations: [
        'Persistent contexts expose no browser process handle; the profile report keeps that unknown at its own layer.',
        'Process evidence comes from the parent child lease (Node parent ancestry), not from a browser PID.',
        'Persistent driver defaults differ from BrowserServer defaults; compare the common caller ignore-list only.',
        ...(versions.length > 1 ? [`Multiple browser versions observed in one run: ${versions.join(', ')}`] : []),
        ...(profileCleanup.limitations ?? []),
        ...(processTree.limitations ?? [])
      ]
    },
    aborted: Boolean(runError) || Boolean(signal?.aborted) || !closed
  };
}
