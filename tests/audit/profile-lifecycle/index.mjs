// Profile-lifecycle suite: runScenarios() entry point.
//
// One persistent context at a time, each on its own lab-owned user-data-dir, all
// served from one loopback fixture server. The caller supplies an explicit
// environment snapshot: headless launches never see a display key, and headed
// launches require the display the caller names.

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, privateDirectory, safeError } from '../lib/secure-io.mjs';
import { bounded, summarizeResult } from '../lib/outcomes.mjs';
import { baseEnvFrom, displayKeys, envKeys } from './lib/env.mjs';
import { assertSafeArguments } from './lib/flags.mjs';
import { createLab } from './lib/lab.mjs';
import { ownedRoot } from './lib/profile.mjs';
import { startLabServer } from './lib/server.mjs';
import { scenario as launchContract } from './scenarios/launch-contract.mjs';
import { scenario as profilePersistence } from './scenarios/profile-persistence.mjs';
import { scenario as profileIsolation } from './scenarios/profile-isolation.mjs';
import { scenario as storageState } from './scenarios/storage-state.mjs';
import { scenario as portableCookies } from './scenarios/portable-cookies.mjs';
import { scenario as profileMetadata } from './scenarios/profile-metadata.mjs';
import { scenario as seedPersistence } from './scenarios/seed-persistence.mjs';
import { scenario as extensionMv3 } from './scenarios/extension-mv3.mjs';
import { scenario as searchEngine } from './scenarios/search-engine.mjs';

export const SCHEMA = 'cloakium.profile-lifecycle-observations/1';
export const OWNED_PROFILE_ROOT = ownedRoot();
export { baseEnvFrom };

export const scenarios = [
  launchContract,
  profilePersistence,
  profileIsolation,
  storageState,
  portableCookies,
  profileMetadata,
  seedPersistence,
  extensionMv3,
  searchEngine
];

export const scenarioIds = scenarios.map((scenario) => scenario.id);

export function classify(result) {
  return summarizeResult(result).status;
}

function writeArtifact(file, value) {
  return atomicJson(file, value);
}

function writeRolling(file, value) {
  return atomicJson(file, value, { overwrite: true });
}

function resolveWorkRoot({ workRoot, output }) {
  if (workRoot === undefined) return path.join(output, 'profiles');
  const resolved = path.resolve(workRoot);
  if (!(resolved + path.sep).startsWith(ownedRoot())) {
    throw new Error('runScenarios: workRoot must be inside the private audit root');
  }
  return resolved;
}

async function assertFreshOutput(output, selected) {
  const candidates = ['report.json', ...selected.map((scenario) => `${scenario.id}.json`)];
  for (const name of candidates) {
    const file = path.join(output, name);
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) throw new Error(`runScenarios: refusing to reuse an existing artifact ${name}`);
  }
}

function cleanupReceipt(lab) {
  const stats = lab.stats();
  return {
    contextsOpened: stats.contextsOpened,
    contextsClosed: stats.contextsClosed,
    activeProfiles: stats.activeContexts,
    failedCleanup: stats.failedCleanup,
    processVerification: 'not-exposed-by-public-persistent-context-api',
    profilesRetained: stats.profilesRetained,
    limitations: [
      'launchPersistentContext spawns the browser process internally; the public API exposes no process handle, so descendant processes cannot be verified by this suite.',
      'A BrowserServer transport exposes server.process(); this suite deliberately uses the persistent-context API, so process-tree proof belongs to the browser-launch group.',
      'Cleanup proof here is therefore context-level: every owned context closed and no profile remained attached.'
    ]
  };
}

export async function runScenarios(options = {}) {
  const {
    chromium,
    executablePath,
    headless = true,
    baseArgs = [],
    baseEnv,
    ignoreDefaultArgs = [],
    contextOptions = null,
    output,
    scenarios: selection = null,
    masterSeed = null,
    keepProfiles = false,
    signal = null,
    log = () => {}
  } = options;

  if (!output) throw new Error('runScenarios: output is required');
  if (!path.isAbsolute(output)) throw new Error('runScenarios: output must be absolute');
  if (!executablePath || !path.isAbsolute(executablePath)) {
    throw new Error('runScenarios: executablePath must be absolute');
  }
  if (!baseEnv || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    throw new Error('runScenarios: baseEnv must be supplied explicitly by the caller');
  }
  assertSafeArguments(baseArgs);
  const unknown = selection?.filter((id) => !scenarioIds.includes(id)) ?? [];
  if (unknown.length) throw new Error(`runScenarios: unknown scenario ${unknown.join(', ')}`);
  const selected = selection
    ? scenarios.filter((scenario) => selection.includes(scenario.id))
    : scenarios;
  if (selected.length === 0) throw new Error('runScenarios: no scenario selected');

  await privateDirectory(output);
  await assertFreshOutput(output, selected);
  const workRoot = resolveWorkRoot({ workRoot: options.workRoot, output });
  await privateDirectory(workRoot);
  const server = await startLabServer();
  const lab = createLab({
    chromium, executablePath, headless, baseArgs, baseEnv, ignoreDefaultArgs,
    contextOptions, workRoot, keepProfiles
  });
  await lab.initialise();

  const report = {
    schema: SCHEMA,
    started: new Date().toISOString(),
    engine: {
      executablePath,
      headless,
      baseArgs,
      envKeys: envKeys(baseEnv),
      displayKeys: headless ? [] : displayKeys(baseEnv),
      ignoreDefaultArgs: [...ignoreDefaultArgs],
      contextOptions: { ...(contextOptions ?? {}) }
    },
    client: { node: process.version },
    workRoot,
    scenarios: [],
    errors: [],
    status: 'running'
  };
  const reportPath = path.join(output, 'report.json');
  let reportWritten = false;
  const persist = async () => {
    if (!reportWritten) {
      await writeArtifact(reportPath, report);
      reportWritten = true;
      return;
    }
    await writeRolling(reportPath, report);
  };
  await persist();

  const interrupted = () => Boolean(signal?.aborted);
  let abortedAfter = null;

  try {
    for (const scenario of selected) {
      if (interrupted() || abortedAfter) {
        report.scenarios.push({
          id: scenario.id,
          optional: Boolean(scenario.optional),
          status: 'skipped',
          limitations: [{ code: 'not-run', detail: abortedAfter ? `aborted after ${abortedAfter}` : 'signal received' }],
          checks: []
        });
        continue;
      }
      const entry = {
        id: scenario.id,
        optional: Boolean(scenario.optional),
        timeoutMs: scenario.timeoutMs,
        started: new Date().toISOString()
      };
      try {
        const result = await bounded(
          () => scenario.run({
            lab,
            server,
            output,
            workRoot,
            baseArgs,
            headless,
            executablePath,
            chromium,
            options: { masterSeed, keepProfiles },
            log
          }),
          scenario.timeoutMs,
          scenario.id
        );
        Object.assign(entry, result, { status: classify(result) });
      } catch (error) {
        entry.status = 'execution-error';
        entry.error = safeError(error, `${scenario.id} run`);
        entry.deadline = error?.code === 'AUDIT_DEADLINE';
        abortedAfter = scenario.id;
        report.errors.push({ scenario: scenario.id, error: entry.error });
      } finally {
        if (lab.current) {
          try {
            await lab.closeAll();
          } catch (error) {
            entry.cleanupError = safeError(error, `${scenario.id} close`);
          }
          entry.status = 'execution-error';
          entry.cleanupError = entry.cleanupError ?? {
            operation: `${scenario.id} close`,
            category: 'context-left-open',
            detail: 'The scenario returned while its persistent context was still open.'
          };
        }
        if (lab.failedCleanup) abortedAfter = scenario.id;
        entry.finished = new Date().toISOString();
      }
      report.scenarios.push(entry);
      await writeArtifact(path.join(output, `${scenario.id}.json`), entry);
      await persist();
      log(`${scenario.id}: ${entry.status}`);
    }
  } finally {
    let disposeError = null;
    try {
      await lab.dispose();
    } catch (error) {
      disposeError = safeError(error, 'dispose');
      report.errors.push({ scenario: 'dispose', error: disposeError });
    }
    try {
      await server.close();
    } catch (error) {
      report.errors.push({ scenario: 'server', error: safeError(error, 'server close') });
    }
    const cleanup = cleanupReceipt(lab);
    if (disposeError) cleanup.disposeError = disposeError;
    report.browserVersions = [...new Set(
      lab.launches.map((entry) => entry.version).filter((value) => typeof value === 'string' && value.length > 0)
    )];
    report.launches = lab.launches.map((entry) => ({
      label: entry.label,
      headless: entry.headless,
      version: typeof entry.version === 'string' ? entry.version : null,
      args: [...entry.args],
      ignoreDefaultArgs: [...(entry.ignoreDefaultArgs ?? [])],
      contextOptions: { ...(entry.contextOptions ?? {}) },
      envKeys: [...(entry.envKeys ?? [])],
      displayKeys: [...(entry.displayKeys ?? [])],
      launchedAt: entry.launchedAt,
      closedAt: entry.closedAt ?? null
    }));
    report.profilesKept = keepProfiles;
    report.cleanup = cleanup;
    report.finished = new Date().toISOString();
    const failing = report.scenarios.some((entry) => entry.status === 'execution-error')
      || cleanup.failedCleanup
      || cleanup.activeProfiles > 0;
    const inconsistent = report.scenarios.some((entry) => entry.status === 'observed-inconsistency');
    report.status = failing ? 'failed' : inconsistent ? 'inconsistent' : 'observed';
    await persist();
  }
  return report;
}
