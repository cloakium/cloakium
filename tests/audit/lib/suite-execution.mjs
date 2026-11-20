// Generic suite executor: one BrowserServer (or one persistent context) at a
// time, per-scenario fixtures, per-probe fresh contexts, parent-owned safety.
//
// Transport note: ordinary suites launch a BrowserServer through the public
// Playwright API and use its public `process()` handle for cleanup. The profile
// suite launches persistent contexts, which expose no process handle; ownership
// there comes from the parent-provided child lease (Node parent ancestry) and the
// lease never reports or signals the Node parent or pre-existing fixtures.

import {
  assertSandboxArguments, inspectSandbox, launchBrowser
} from './browser.mjs';
import { observeEnvironment } from './environment.mjs';
import { executeProfile } from '../profile-lifecycle/lib/execute-profile.mjs';
import { bounded, summarizeResult } from './outcomes.mjs';
import { safeError } from './secure-io.mjs';
import {
  assertSafeBaseArgs, assertSharedProbeLab, closeLab, effectiveIgnoreDefaultArgs, errorRow,
  fixtureDiagnostics, labOptionsFor, launchRecord, mergeContextOptions, mergePriorResults,
  runStaticExportScenario, unavailableRow
} from './suite-support.mjs';
import { startSocketWitness } from './socket-witness.mjs';
import { loadSuite } from './suites.mjs';

const DISPLAY_KEYS = ['DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY'];
const CONTEXT_CLOSE_MS = 10_000;
const BROWSER_STARTUP_MS = 60_000;
const BROWSER_CLEANUP_MS = 15_000;

function assertLaunchOptions(mode, launchEnv, baseArgs, probeConfig) {
  if (!['headless', 'headed'].includes(mode)) throw new Error('configuration.mode must be headless or headed');
  if (!launchEnv || typeof launchEnv !== 'object' || Array.isArray(launchEnv)) {
    throw new Error('launchEnv must be an explicit environment object');
  }
  if (!Array.isArray(baseArgs) || baseArgs.some((argument) => typeof argument !== 'string')) {
    throw new Error('baseArgs must be an array of strings');
  }
  const hasDisplay = DISPLAY_KEYS.some((key) => Object.hasOwn(launchEnv, key));
  if (mode === 'headless' && hasDisplay) throw new Error('Headless launch must not carry a display endpoint');
  if (mode === 'headed' && !launchEnv.DISPLAY) throw new Error('Headed launch requires an explicit owned DISPLAY');
  assertSafeBaseArgs(baseArgs);
  effectiveIgnoreDefaultArgs(probeConfig?.ignoreDefaultArgs, []);
  assertSandboxArguments(baseArgs);
}

/**
 * Execute one suite.
 * @param {object} options
 * @param {string} options.suiteId
 * @param {string[]} [options.probeIds]
 * @param {string[]} [options.scenarioIds]
 * @param {object} options.chromium
 * @param {{executablePath:string}} options.target
 * @param {{id?:string,mode:string,contextOptions?:object,seed?:string|number,profileId?:string,probeConfig?:object,priorResults?:object,positiveControl?:boolean}} options.configuration
 * @param {{locale:string,timezoneId:string}} options.environment
 * @param {string} options.output absolute private output root
 * @param {object} options.launchEnv explicit env; display keys only for headed
 * @param {string[]} options.baseArgs pre-combined, placeholder-resolved arguments
 * @param {AbortSignal} [options.signal]
 * @param {(row:object)=>Promise<void>} [options.onObservation]
 * @param {{launchBrowser?:Function,startLab?:Function,inspectSandbox?:Function,observeEnvironment?:Function,runScenarios?:Function,childLease?:Function}} [dependencies]
 */
export async function executeSuite(options = {}, dependencies = {}) {
  const { suiteId, target, configuration, environment, launchEnv, baseArgs, output, signal } = options;
  const suite = await loadSuite(suiteId);
  if (!target?.executablePath) throw new Error('target.executablePath is required');
  if (typeof target.executablePath !== 'string' || !target.executablePath.startsWith('/')) {
    throw new Error('target.executablePath must be absolute');
  }
  if (!configuration || typeof configuration !== 'object') throw new Error('configuration is required');
  if (!environment?.locale || !environment?.timezoneId) throw new Error('environment.locale and environment.timezoneId are required');
  if (typeof output !== 'string' || !output.startsWith('/')) throw new Error('output must be an absolute path');
  assertLaunchOptions(configuration.mode, launchEnv, baseArgs, configuration.probeConfig);

  const observations = [];
  const sessions = [];
  const errors = [];
  const onObservation = options.onObservation ?? null;
  const context = { suite, options: { ...options, launchEnv, baseArgs }, dependencies, observations, sessions, errors };

  if (suite.kind === 'profile') {
    const result = await executeProfile(context);
    return { observations, sessions, errors, cleanup: result.cleanup, aborted: result.aborted };
  }

  const launch = dependencies.launchBrowser ?? launchBrowser;
  const inspect = dependencies.inspectSandbox ?? inspectSandbox;
  const observe = dependencies.observeEnvironment ?? observeEnvironment;
  const fallbackSuite = await loadSuite('network');
  const startLab = dependencies.startLab ?? suite.startLab ?? fallbackSuite.startLab;

  const selectedProbeIds = options.probeIds ? [...options.probeIds] : null;
  if (selectedProbeIds) {
    const unknown = selectedProbeIds.filter((id) => !suite.probeIds.includes(id));
    if (unknown.length) throw new Error(`Unknown probe id(s) for suite ${suite.id}: ${unknown.join(', ')}`);
  }
  if (suite.kind !== 'scenarios' && options.scenarioIds !== undefined) {
    throw new Error(`Suite ${suite.id} has no scenarios`);
  }
  if (options.scenarioIds !== undefined && (!Array.isArray(options.scenarioIds) || options.scenarioIds.length === 0)) {
    throw new Error('scenarioIds must be a non-empty array');
  }
  const scenarioSelection = suite.kind === 'scenarios' ? (options.scenarioIds ?? suite.scenarioIds) : [];
  for (const scenarioId of scenarioSelection) {
    if (!suite.scenarioIds.includes(scenarioId)) {
      throw new Error(`Unknown scenario id for suite ${suite.id}: ${scenarioId}`);
    }
  }
  const groups = suite.kind === 'scenarios'
    ? scenarioSelection.map((scenarioId) => ({
      scenarioId,
      declared: suite.scenarios?.find((scenario) => scenario.id === scenarioId)?.probes ?? null
    }))
    : [{ scenarioId: null, declared: suite.probeIds }];

  const labReceipts = [];
  let sharedFixtureUsed = null;
  let aborted = false;
  // Positive-control linkage: earlier rows from THIS execution (one target,
  // mode and configuration) may feed probes that need a prior result.
  let priorResults = { ...(configuration.priorResults ?? {}) };

  for (const group of groups) {
    if (signal?.aborted) { aborted = true; break; }
    const planProbeIds = group.declared ?? null;
    // Probe-kind suites may borrow the runner's single plan-wide origin so the
    // security origin stays identical across every configuration. The executor
    // never closes a borrowed fixture; the runner owns it until plan end.
    const borrowedFixture = suite.kind === 'probes' && options.sharedProbeLab
      ? assertSharedProbeLab(options.sharedProbeLab)
      : null;
    if (borrowedFixture) sharedFixtureUsed = borrowedFixture;
    let lab = null;
    try {
      lab = borrowedFixture ?? await startLab(labOptionsFor(planProbeIds));
    } catch (error) {
      errors.push({ scope: 'lab-start', scenarioId: group.scenarioId, error: safeError(error, 'lab start') });
      aborted = true;
      const reason = 'Fixture lab could not be started.';
      for (const probe of suite.probes.filter((entry) => !selectedProbeIds || selectedProbeIds.includes(entry.id))) {
        observations.push(unavailableRow({ id: probe.id, family: probe.family, suiteId: suite.id, scenarioId: group.scenarioId }, reason));
      }
      break;
    }

    try {
      const extra = suite.id === 'extended-network' && configuration.probeConfig?.launcherArgs
        ? { launcherArgs: configuration.probeConfig.launcherArgs }
        : undefined;
      const plan = suite.scenarioLaunch
        ? (extra ? suite.scenarioLaunch(group.scenarioId, lab, extra) : suite.scenarioLaunch(group.scenarioId, lab))
        : null;
      let probes = plan ? plan.probes.map((id) => suite.probes.find((probe) => probe.id === id)).filter(Boolean)
        : suite.probes;
      if (selectedProbeIds) probes = probes.filter((probe) => selectedProbeIds.includes(probe.id));

      let browserFailure = false;
      let sessionOverrides = [];
      const emit = async (row) => {
        observations.push(row);
        if (!onObservation) return;
        try {
          await onObservation(row);
        } catch (error) {
          errors.push({ scope: 'on-observation', scenarioId: group.scenarioId, probeId: row.id, error: safeError(error, 'observation callback') });
          browserFailure = true;
        }
      };
      const ignoreDefaultArgs = effectiveIgnoreDefaultArgs(
        configuration.probeConfig?.ignoreDefaultArgs,
        plan?.launch.ignoreDefaultArgs ?? []
      );
      const scenarioBase = { suiteId: suite.id, scenarioId: group.scenarioId };
      if (plan?.skipReason) {
        for (const probe of probes) {
          await emit(unavailableRow({ id: probe.id, family: probe.family, ...scenarioBase }, plan.skipReason));
        }
        continue;
      }

      if (plan?.profileLifecycle === 'caller-profile') {
        const staticProbe = probes.find((probe) => probe.id === 'profile.export.security');
        if (!staticProbe) continue;
        const outcome = await runStaticExportScenario({
          suiteId: suite.id,
          scenarioId: group.scenarioId,
          probe: staticProbe,
          plan,
          options,
          configuration,
          environment,
          target,
          launchEnv,
          baseArgs,
          output,
          signal,
          emit,
          sessions,
          errors,
          dependencies,
          ignoreDefaultArgs,
          lab
        });
        if (outcome.aborted) {
          aborted = true;
          break;
        }
        continue;
      }

      const args = [...baseArgs, ...(plan?.launch.args ?? [])];
      assertSandboxArguments(args);
      let session;
      try {
        session = await launch({
          chromium: options.chromium,
          executablePath: target.executablePath,
          mode: configuration.mode,
          args,
          env: launchEnv,
          ignoreDefaultArgs,
          launchProxy: plan?.launch.proxy ?? undefined,
          startupMs: BROWSER_STARTUP_MS,
          cleanupMs: BROWSER_CLEANUP_MS
        });
      } catch (error) {
        errors.push({ scope: 'browser-launch', scenarioId: group.scenarioId, error: error?.auditError ?? safeError(error, 'browser launch') });
        aborted = true;
        for (const probe of probes) {
          observations.push(errorRow({ id: probe.id, family: probe.family, ...scenarioBase }, error, 'browser launch'));
        }
        break;
      }

      // Passive socket witness: samples the owned BrowserServer process tree
      // while it is alive. Diagnostics only; it never gates the product verdict.
      let witness = null;
      let witnessRecord = null;
      if (dependencies.socketWitness !== false) {
        const witnessFactory = dependencies.socketWitnessFactory ?? startSocketWitness;
        try {
          witness = witnessFactory({ tracker: { sample: session.sample } });
        } catch (error) {
          witnessRecord = {
            available: false,
            absenceEstablished: false,
            reason: error?.code === 'unsupported-platform' ? 'unsupported-platform' : 'start-failed',
            limitation: safeError(error, 'socket witness').category
          };
        }
      } else {
        witnessRecord = { available: false, absenceEstablished: false, reason: 'disabled-by-caller' };
      }

      let sandbox;
      try {
        sandbox = await inspect(session.browser);
      } catch (error) {
        sandbox = { status: 'unavailable', configured: true };
        errors.push({ scope: 'sandbox', scenarioId: group.scenarioId, error: safeError(error, 'sandbox check') });
      }
      const baseOptions = mergeContextOptions(environment, configuration, plan, { contextOptions: {} }).options;
      let environmentObservation = null;
      try {
        environmentObservation = await observe(session.browser, lab.origin, baseOptions);
      } catch (error) {
        errors.push({ scope: 'environment', scenarioId: group.scenarioId, error: safeError(error, 'environment observation') });
      }
      let version = null;
      try { version = session.browser.version(); } catch { version = null; }

      const baseConfig = {
        ...(suite.configForScenario
          ? suite.configForScenario(plan, { playwrightDefaults: true, trustLabCa: false })
          : {}),
        suiteId: suite.id,
        scenarioId: group.scenarioId,
        configurationId: configuration.id ?? null,
        seed: configuration.seed ?? null,
        profileId: configuration.profileId ?? null,
        probeConfig: configuration.probeConfig ?? null,
        ...(configuration.probeConfig?.expectedNavigator
          ? { expectedNavigator: configuration.probeConfig.expectedNavigator }
          : {}),
        playwrightDefaults: true,
        ignoreDefaultArgs,
        contextOptions: baseOptions,
        ...(configuration.positiveControl === undefined ? {} : { positiveControl: configuration.positiveControl })
      };

      for (const probe of probes) {
        const rowBase = {
          id: probe.id, family: probe.family, suiteId: suite.id, scenarioId: group.scenarioId,
          started: new Date().toISOString()
        };
        if (signal?.aborted || browserFailure) {
          await emit(unavailableRow(rowBase, browserFailure ? 'Skipped after a context cleanup failure.' : 'Run aborted by signal.'));
          if (signal?.aborted) aborted = true;
          continue;
        }
        const merged = mergeContextOptions(environment, configuration, plan, probe);
        sessionOverrides = [...new Set([...sessionOverrides, ...merged.overrides])];
        const config = { ...baseConfig, priorResults };
        let context;
        try {
          context = await session.browser.newContext(merged.options);
        } catch (error) {
          await emit(errorRow(rowBase, error, `${probe.id} context`));
          browserFailure = true;
          continue;
        }
        const contextsBefore = new Set(session.browser.contexts?.() ?? []);
        let row;
        try {
          const page = await context.newPage();
          const cap = configuration.probeConfig?.probeTimeoutMs;
          const budget = Number.isFinite(cap) && cap > 0 ? Math.min(cap, probe.timeoutMs) : probe.timeoutMs;
          const deadline = Date.now() + budget;
          const result = await bounded(
            () => probe.run({
              page, context, browser: session.browser, origin: lab.origin, crossOrigin: lab.crossOrigin,
              lab, config, deadline
            }),
            budget,
            probe.id
          );
          const summary = summarizeResult(result);
          row = { ...rowBase, status: summary.status, result, counts: summary.counts };
        } catch (error) {
          row = errorRow(rowBase, error, `${probe.id} run`);
          errors.push({ scope: 'probe', scenarioId: group.scenarioId, probeId: probe.id, error: row.error });
        } finally {
          // Close the probe context and any context the probe opened itself: a
          // timed-out probe never reaches its own cleanup, so the executor owns
          // everything that appeared inside this probe window.
          const created = (session.browser.contexts?.() ?? []).filter((entry) => !contextsBefore.has(entry));
          if (!created.includes(context)) created.push(context);
          for (const owned of created) {
            try {
              await bounded(() => owned.close(), CONTEXT_CLOSE_MS, `${probe.id} context close`);
            } catch (error) {
              const cleanupError = safeError(error, `${probe.id} context close`);
              errors.push({ scope: 'context-cleanup', scenarioId: group.scenarioId, probeId: probe.id, error: cleanupError });
              if (!row) row = errorRow(rowBase, error, `${probe.id} run`);
              row.status = 'execution-error';
              row.cleanup = { closed: false, error: cleanupError };
              browserFailure = true;
            }
          }
        }
        row.version = version;
        row.environment = environmentObservation;
        row.transport = session.transport;
        row.finished = new Date().toISOString();
        await emit(row);
        priorResults = mergePriorResults(priorResults, [{ id: row.id, counts: row.counts }]);
      }

      // Witness first: the owned BrowserServer process must still be alive when
      // the final sample and receipt are taken. Diagnostics only, never a verdict.
      let socketWitness = witnessRecord;
      if (witness) {
        try {
          await witness.sample();
        } catch {
          /* the witness records its own sampling limitations */
        }
        try {
          socketWitness = await witness.close();
        } catch (error) {
          socketWitness = {
            available: false,
            absenceEstablished: false,
            reason: 'close-failed',
            limitation: safeError(error, 'socket witness').category
          };
        }
      }

      let cleanup;
      try {
        cleanup = await session.close();
      } catch (error) {
        cleanup = { closed: false, remaining: [], limitations: [], error: safeError(error, 'browser close') };
      }
      sessions.push({
        suiteId: suite.id,
        scenarioId: group.scenarioId,
        transport: session.transport,
        version,
        environment: environmentObservation,
        sandbox,
        diagnostics: {
          fixture: fixtureDiagnostics(lab, { borrowed: Boolean(borrowedFixture) })
        },
        launch: launchRecord(args, ignoreDefaultArgs, baseOptions, sessionOverrides),
        socketWitness: socketWitness ?? { available: false, absenceEstablished: false, reason: 'not-started' },
        cleanup
      });
      if (!cleanup || cleanup.closed !== true) {
        aborted = true;
        errors.push({
          scope: 'browser-cleanup',
          scenarioId: group.scenarioId,
          error: cleanup?.error ?? {
            operation: 'browser cleanup',
            category: 'processes-remaining',
            detail: 'The BrowserServer cleanup did not report a closed session.'
          }
        });
      }
    } finally {
      if (!borrowedFixture) {
        const receipt = await closeLab(lab);
        labReceipts.push({ scenarioId: group.scenarioId, ...receipt });
        if (!receipt.closed) {
          aborted = true;
          errors.push({ scope: 'lab-cleanup', scenarioId: group.scenarioId, errors: receipt.errors });
        }
      }
      if (aborted) break;
    }
    if (aborted) break;
  }

  const closed = labReceipts.every((receipt) => receipt.closed)
    && sessions.every((session) => session.cleanup?.closed === true);
  const staticSessions = sessions.filter((session) => session.transport === 'static-profile-export-fixture');
  const staticVerified = staticSessions.length > 0
    && staticSessions.every((session) => session.cleanup?.processVerification === 'fixture-owned-lease-verified');
  return {
    observations,
    sessions,
    errors,
    cleanup: {
      suiteId: suite.id,
      transport: staticSessions.length > 0 && staticSessions.length === sessions.length
        ? 'static-profile-export-fixture'
        : suite.transport,
      processVerification: staticVerified ? 'fixture-owned-lease-verified' : (staticSessions.length ? 'unknown' : undefined),
      sharedFixture: sharedFixtureUsed
        ? {
          borrowed: true,
          ownedBy: 'audit-runner',
          closed: false,
          retainedUntilPlanEnd: true,
          origin: sharedFixtureUsed.origin,
          crossOrigin: sharedFixtureUsed.crossOrigin,
          port: sharedFixtureUsed.port,
          sha256: sharedFixtureUsed.receipt?.sha256 ?? null
        }
        : (options.sharedProbeLab
          ? { provided: true, used: false, reason: `suite-kind-${suite.kind}` }
          : null),
      staticFixtures: staticSessions.map((session) => ({
        before: session.cleanup?.before ?? null,
        after: session.cleanup?.after ?? null,
        unknown: session.cleanup?.unknown ?? null,
        closed: session.cleanup?.closed ?? null
      })),
      closed,
      remaining: sessions.flatMap((session) => session.cleanup?.remaining ?? []),
      sessions: sessions.length,
      fixtures: labReceipts,
      limitations: [
        'BrowserServer cleanup proves the launch root exited and tracked descendants are gone; it is not an OS-wide process audit.',
        ...labReceipts.flatMap((receipt) => (receipt.errors ?? []).map((error) => `Fixture cleanup: ${error.category}`))
      ]
    },
    aborted
  };
}
