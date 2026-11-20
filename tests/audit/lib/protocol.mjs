import { checkVerdict } from "./outcomes.mjs";
import { safeError } from "./secure-io.mjs";

export function observationId(row) {
  return [row.suiteId, row.scenarioId ?? "default", row.id].join(".");
}

export function canonicalObservation(row) {
  const result = row.result ?? { observations: {}, checks: [], limitations: [] };
  const sample = result.observations;
  const observations = sample && typeof sample === "object" && !Array.isArray(sample) ? { ...sample } : { sample };
  if (Object.hasOwn(observations, "$audit")) throw new Error("Probe used a reserved observation field");
  observations.$audit = {
    probeId: row.id, suiteId: row.suiteId, scenarioId: row.scenarioId ?? null,
    sourceStatus: row.status, originalChecks: result.checks, originalLimitations: result.limitations,
    ...(row.error ? { error: row.error } : {}),
    ...(result.coverage ? { coverage: result.coverage } : {}),
  };
  return {
    id: observationId(row), family: row.family,
    status: row.status === "execution-error" ? "error"
      : ["skipped", "unavailable"].includes(row.status) ? "skipped" : "observed",
    result: {
      observations,
      checks: result.checks.map(check => ({
        name: check.name, passed: check.passed,
        status: check.status === "unsupported-by-target" ? "unsupported" : checkVerdict(check),
      })),
      limitations: result.limitations.map(value => typeof value === "string" ? value : JSON.stringify(value)),
    },
  };
}

export function canonicalError(input, configurationId) {
  const error = input.error ?? input.auditError ?? safeError(input, input.scope ?? "execution");
  const category = error.category ?? "operation-failed";
  const operation = String(error.operation ?? "suite-execution")
    .replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 64) || "suite-execution";
  return {
    kind: category === "timeout" ? "timeout" : /cleanup/.test(input.scope ?? "") ? "cleanup"
      : input.scope === "inventory" ? "inventory"
        : ["configuration", "coverage", "preflight"].includes(input.scope) ? "configuration" : "execution",
    phase: input.scope ?? "suite",
    ...(configurationId ? { configurationId } : {}),
    ...(error.code ? { code: error.code } : {}),
    operation,
    targetClosed: category === "target-closed",
    ...(category === "timeout" ? { timeoutCategory: "probe-or-resource-deadline" } : {}),
    message: `Audit operation recorded ${category}; raw target and driver text was omitted.`,
  };
}

export function canonicalCleanup(results) {
  const clean = results.length > 0 && results.every(result => result.cleanup?.closed === true);
  return {
    status: clean ? "clean" : "incomplete",
    browserClosed: clean, contextsClosed: clean, processExited: clean,
    notes: clean ? [] : ["At least one suite did not establish clean resource shutdown."],
  };
}

export function executionComplete(fragment, plannedCount) {
  return fragment.runs.length === plannedCount && fragment.errors.length === 0 &&
    fragment.runs.every(run => run.cleanup.status === "clean" && run.observations.length > 0 &&
      run.observations.every(row => !["error", "skipped"].includes(row.status)));
}
