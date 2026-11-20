import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, hashValue, loadDriver, sourceManifest } from "./hashes.mjs";
import { atomicJson, privateDirectory, safeError } from "./secure-io.mjs";
import { launchEnvironment, cleanupLaunchEnvironment, environmentReceipt, validateOutput } from "./environment.mjs";
import { createDisplayManager, displayArguments } from "./display.mjs";
import { fontInventory } from "./fonts.mjs";
import { acquireSeat } from "./seat.mjs";
import { snapshotSources } from "./snapshot.mjs";
import { startSharedProbeFixture } from "./fixtures.mjs";
import { executeSuite } from "./suite-execution.mjs";
import { additionalExecutableDigests, baseEnvironment, preflightPlan, targetDigests } from "./runner-preflight.mjs";
import { configurationSelections, suiteManifest } from "./runner-manifest.mjs";
import { canonicalObservation, canonicalCleanup, canonicalError, executionComplete, observationId } from "./protocol.mjs";

const auditRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = path.resolve(auditRoot, "../..");
const runnerFile = path.join(auditRoot, "run.mjs");

async function archiveSources(output, manifest) {
  const root = path.join(output, "source-snapshot");
  const tree = path.join(root, "tests", "audit");
  await privateDirectory(path.dirname(tree));
  const snapshot = await snapshotSources(auditRoot, tree, manifest);
  const manifestFile = path.join(root, "snapshot-manifest.json");
  await fs.link(path.join(tree, "snapshot-manifest.json"), manifestFile);
  await fs.unlink(path.join(tree, "snapshot-manifest.json"));
  return { ...snapshot, root, manifestFile };
}

export function sharedFixturePolicy(plan, selections) {
  const policies = plan.configurations.flatMap((configuration, index) =>
    selections[index].some(suite => suite.kind === "probes")
      ? [configuration.suiteOptions?.sharedFixture ?? { port: 0 }] : []);
  if (!policies.length) return null;
  for (const policy of policies)
    if (!policy || Array.isArray(policy) || Object.keys(policy).some(key => key !== "port") ||
        !Number.isInteger(policy.port ?? 0) || (policy.port ?? 0) < 0 || (policy.port ?? 0) > 65535)
      throw new Error("Shared fixture policy only accepts a loopback port");
  const normalized = policies.map(policy => ({ port: policy.port ?? 0 }));
  if (new Set(normalized.map(hashValue)).size !== 1)
    throw new Error("All probe configurations must share the same fixture policy");
  return normalized[0];
}

function notRun(selection, reason) {
  return selection.flatMap(suite => suite.rows.map(row => canonicalObservation({
    ...row, status: "skipped",
    result: { observations: { notRunReason: reason }, checks: [{ name: "probe-executed", passed: null }], limitations: [reason] },
  })));
}

function clientRecord(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined));
}

export async function runAudit({ plan: planFile, output }, dependencies = {}) {
  process.umask(0o077);
  const planBytes = await fs.readFile(planFile);
  const plan = preflightPlan(JSON.parse(planBytes.toString("utf8")));
  const selections = [];
  for (const config of plan.configurations) selections.push(await configurationSelections(config));
  output = await validateOutput(output, projectRoot);
  for (const name of ["runner-report.json", "runner-progress.json", "runner-inputs.json"])
    if (await fs.lstat(path.join(output, name)).then(() => true, () => false))
      throw new Error("Audit runner refuses an existing output artifact");
  const seat = await (dependencies.acquireSeat ?? acquireSeat)();
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const displayManager = (dependencies.createDisplayManager ?? createDisplayManager)({
    settings: plan.environment.display, helper: process.env.CLOAKIUM_AUDIT_DISPLAY_BIN, output,
  });
  const fragment = {
    schema: "cloakium.audit.runner/1", planId: plan.id, planHash: await hashFile(planFile),
    runs: [], errors: [],
  };
  const drivers = new Map();
  let before;
  let manifest;
  let environment;
  let additionalExecutables;
  let sourceSnapshot;
  let sharedFixture;
  let preventLaunch = false;
  let resourcesVerified = true;
  const started = new Date().toISOString();
  try {
    before = await (dependencies.targetDigests ?? targetDigests)(plan.targets);
    additionalExecutables = await additionalExecutableDigests(plan);
    environment = await baseEnvironment(plan, output);
    manifest = await (dependencies.suiteManifest ?? suiteManifest)(auditRoot, selections);
    sourceSnapshot = await (dependencies.archiveSources ?? archiveSources)(output, manifest.source);
    fragment.suite = {
      manifestSha256: /^[a-f0-9]{64}$/.test(process.env.CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256 ?? "")
        ? process.env.CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256 : await hashFile(runnerFile),
      probes: manifest.probes,
    };
    fragment.environment = environment;
    const fixturePolicy = sharedFixturePolicy(plan, selections);
    if (fixturePolicy) {
      sharedFixture = await (dependencies.startSharedProbeFixture ?? startSharedProbeFixture)(fixturePolicy);
      environment.diagnostics ??= {};
      environment.diagnostics.sharedProbeFixture = sharedFixture.receipt;
    }
    for (const target of plan.targets)
      if (!drivers.has(target.clientModule))
        drivers.set(target.clientModule, await (dependencies.loadDriver ?? loadDriver)(target.clientModule));
    await atomicJson(path.join(output, "runner-inputs.json"), {
      schema: "cloakium.audit.runner-inputs/1", planHash: fragment.planHash, targets: before,
      sources: manifest.source, clients: [...drivers.values()].map(driver => driver.metadata), started,
      additionalExecutables,
      sourceSnapshot,
      sharedProbeFixture: sharedFixture?.receipt ?? null,
    });
    for (const [index, configuration] of plan.configurations.entries()) {
      const target = plan.targets.find(value => value.id === configuration.targetId);
      const driver = drivers.get(target.clientModule);
      const run = {
        configuration, version: "unavailable:not-executed", client: clientRecord(driver.metadata),
        environment: structuredClone(environment), observations: [],
        cleanup: { status: "not-run", notes: [] }, limitations: [],
      };
      const start = Date.now();
      const results = [];
      let executingSuite = false;
      let env;
      let configurationResourcesVerified = true;
      try {
        if (preventLaunch || controller.signal.aborted) {
          run.observations = notRun(selections[index], "No launch permitted after interruption or unverified cleanup.");
          run.limitations.push("This configuration was not executed.");
          continue;
        }
        const display = await displayManager.get(configuration.mode);
        const directory = path.join(output, "configurations", configuration.id);
        await privateDirectory(directory);
        env = await launchEnvironment(plan.environment, directory, configuration.mode, display);
        const fonts = await (dependencies.fontInventory ?? fontInventory)(process.env.CLOAKIUM_FC_LIST_BIN, env);
        const receipt = await environmentReceipt(plan.environment, env, display, fonts, {
          contextOptions: configuration.contextOptions ?? {},
          suiteOptions: configuration.suiteOptions ?? {},
          probeConfig: configuration.probeConfig ?? {},
        });
        run.environment.environmentReceipt = receipt;
        const args = displayArguments([
          ...(target.args ?? []),
          ...(configuration.mode === "headed" ? target.headedArgs ?? [] : target.headlessArgs ?? []),
          ...(configuration.args ?? []),
        ], configuration.mode, display);
        for (const selection of selections[index]) {
          executingSuite = true;
          const result = await (dependencies.executeSuite ?? executeSuite)({
            suiteId: selection.id, probeIds: selection.probeIds, scenarioIds: selection.scenarioIds,
            chromium: driver.chromium, target,
            configuration: { ...configuration, probeConfig: {
              ...(configuration.probeConfig ?? {}), ...(configuration.suiteOptions?.[selection.id] ?? {}),
            } },
            environment: plan.environment,
            output: directory, launchEnv: env, baseArgs: args, signal: controller.signal,
            sharedProbeLab: sharedFixture,
            onObservation: async row => {
              await atomicJson(path.join(directory, "observations", `${hashValue(observationId(row))}.json`), row);
            },
          });
          executingSuite = false;
          results.push(result);
          run.observations.push(...result.observations.map(canonicalObservation));
          fragment.errors.push(...result.errors.map(error => canonicalError(error, configuration.id)));
          if (sharedFixture && selection.kind === "probes" &&
              (!result.sessions.length || result.sessions.some(session => {
                const fixture = session.diagnostics?.fixture;
                return fixture?.origin !== sharedFixture.origin || fixture?.crossOrigin !== sharedFixture.crossOrigin ||
                  fixture?.port !== sharedFixture.port || fixture?.ownership !== "borrowed-owned-runner";
              }))) {
            preventLaunch = true;
            fragment.errors.push(canonicalError({ scope: "configuration",
              error: safeError(new Error(), "shared origin invariant") }, configuration.id));
          }
          for (const session of result.sessions)
            for (const error of session.cleanup?.errors ?? [])
              fragment.errors.push(canonicalError({ scope: "browser-cleanup", error }, configuration.id));
          if (result.cleanup?.closed !== true) {
            preventLaunch = true; resourcesVerified = false; configurationResourcesVerified = false; break;
          }
          if (preventLaunch) break;
        }
        const versions = [...new Set(results.flatMap(result => result.sessions.map(value => value.version)).filter(Boolean))];
        run.version = versions.length ? versions.join(" | ") : "unavailable:not-observed";
        if (versions.length !== 1) run.limitations.push("Exactly one browser version was not established for this configuration.");
        run.environment.diagnostics = {
          ...run.environment.diagnostics, sourcesSha256: manifest.source.sha256,
          sessions: results.flatMap(value => value.sessions), suiteCleanup: results.map(value => value.cleanup),
          additionalExecutables,
          sourceSnapshot,
        };
        run.cleanup = canonicalCleanup(results);
        const expected = new Set(selections[index].flatMap(value => value.rows.map(observationId)));
        for (const row of run.observations) expected.delete(row.id);
        if (expected.size) {
          run.limitations.push(`${expected.size} selected probes were not executed.`);
          preventLaunch = true;
          fragment.errors.push(canonicalError({ scope: "coverage", error: safeError(new Error(), "selected probe coverage") }, configuration.id));
        }
      } catch (error) {
        if (executingSuite) { resourcesVerified = false; configurationResourcesVerified = false; }
        fragment.errors.push(canonicalError({ scope: "configuration", error: safeError(error, "configuration execution") }, configuration.id));
        run.limitations.push("Configuration execution failed; raw diagnostics were omitted.");
        if (!run.observations.length) run.observations = notRun(selections[index], "Configuration execution failed.");
        run.cleanup = results.length ? canonicalCleanup(results) : { status: "incomplete", notes: ["No completed suite cleanup receipt."] };
        preventLaunch = true;
      } finally {
        if (env) {
          try {
            const receipt = await cleanupLaunchEnvironment(env, { resourcesClosed: configurationResourcesVerified });
            run.environment.diagnostics ??= {};
            run.environment.diagnostics.runtimeCleanup = receipt;
            if (!receipt.closed) {
              run.cleanup.status = "incomplete";
              preventLaunch = true; resourcesVerified = false;
            }
          } catch (error) {
            preventLaunch = true; resourcesVerified = false;
            run.cleanup.status = "incomplete";
            fragment.errors.push(canonicalError({ scope: "runtime-cleanup", error: safeError(error, "runtime cleanup") }, configuration.id));
          }
        }
        run.durationMs = Date.now() - start;
        fragment.runs.push(run);
        await atomicJson(path.join(output, "runner-progress.json"), fragment, { overwrite: fragment.runs.length > 1 });
      }
    }
    const after = await (dependencies.targetDigests ?? targetDigests)(plan.targets);
    if (hashValue(before) !== hashValue(after))
      fragment.errors.push(canonicalError({ scope: "inventory", error: safeError(new Error(), "target identity changed") }));
    if (hashValue(additionalExecutables) !== hashValue(await additionalExecutableDigests(plan)))
      fragment.errors.push(canonicalError({ scope: "inventory", error: safeError(new Error(), "additional executable changed") }));
    const finalSources = await (dependencies.sourceManifest ?? sourceManifest)(auditRoot, { allFiles: true });
    if (manifest.source.sha256 !== finalSources.sha256)
      fragment.errors.push(canonicalError({ scope: "inventory", error: safeError(new Error(), "audit sources changed") }));
    for (const [module, driver] of drivers) {
      const checked = await (dependencies.loadDriver ?? loadDriver)(module);
      if (checked.metadata.sha256 !== driver.metadata.sha256)
        fragment.errors.push(canonicalError({ scope: "inventory", error: safeError(new Error(), "client package changed") }));
    }
    fragment.environment.diagnostics = {
      ...fragment.environment.diagnostics, started, finished: new Date().toISOString(),
      sourceManifestSha256: manifest.source.sha256, targetDigestsUnchanged: hashValue(before) === hashValue(after),
    };
  } catch (error) {
    fragment.errors.push(canonicalError({ scope: "preflight", error: safeError(error, "runner preflight") }));
  } finally {
    if (sharedFixture) {
      try {
        const cleanup = await sharedFixture.close();
        if (!cleanup.closed) {
          resourcesVerified = false;
          fragment.errors.push(canonicalError({ scope: "shared-fixture-cleanup",
            error: safeError(new Error(), "shared fixture cleanup") }));
        }
        if (fragment.environment) {
          fragment.environment.diagnostics ??= {};
          fragment.environment.diagnostics.sharedProbeFixtureCleanup = cleanup;
        }
      } catch (error) {
        resourcesVerified = false;
        fragment.errors.push(canonicalError({ scope: "shared-fixture-cleanup",
          error: safeError(error, "shared fixture cleanup") }));
      }
    }
    try {
      const cleanup = await displayManager.close();
      if (!cleanup.closed) {
        resourcesVerified = false;
        fragment.errors.push(canonicalError({ scope: "display-cleanup", error: safeError(new Error(), "display cleanup") }));
      }
      if (fragment.environment) {
        fragment.environment.diagnostics ??= {};
        fragment.environment.diagnostics.displayCleanup = cleanup;
      }
    } catch (error) {
      resourcesVerified = false;
      fragment.errors.push(canonicalError({ scope: "display-cleanup", error: safeError(error, "display cleanup") }));
    }
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await atomicJson(path.join(output, "runner-report.json"), fragment);
    if (resourcesVerified) await seat.release();
  }
  return {
    complete: executionComplete(fragment, plan.configurations.length),
    configurations: fragment.runs.length,
    observations: fragment.runs.reduce((sum, run) => sum + run.observations.length, 0),
    errors: fragment.errors.length, report: path.join(output, "runner-report.json"),
  };
}
