import { isDeepStrictEqual } from "node:util";

export function differences(headed, headless, path = "$") {
  if (isDeepStrictEqual(headed, headless)) return [];
  const object = (value) => value !== null && typeof value === "object";
  if (!object(headed) || !object(headless) || Array.isArray(headed) !== Array.isArray(headless)) {
    return [{ path, headed, headless }];
  }
  const keys = [...new Set([...Object.keys(headed), ...Object.keys(headless)])].sort();
  if (keys.length === 0) return [{ path, headed, headless }];
  return keys.flatMap((key) => {
    const next = Array.isArray(headed) ? `${path}[${key}]` : `${path}.${key}`;
    if (!Object.hasOwn(headed, key) || !Object.hasOwn(headless, key)) {
      return [{
        path: next,
        headed: Object.hasOwn(headed, key) ? headed[key] : { missing: true },
        headless: Object.hasOwn(headless, key) ? headless[key] : { missing: true },
      }];
    }
    return differences(headed[key], headless[key], next);
  });
}

export function leafCount(value) {
  if (value === null || typeof value !== "object") return 1;
  const children = Object.values(value);
  return children.length === 0 ? 1 : children.reduce((sum, child) => sum + leafCount(child), 0);
}

// Diagnostic fields are the only exclusion mechanism: exact top-level
// observation keys, each with a reason. There is no wildcard or path syntax.
const diagnosticKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const placeholderReasons = new Set(["ignore", "ignored", "skip", "skipped", "exclude", "excluded", "n/a"]);

export function declaredDiagnostics(probe) {
  const fields = probe.diagnostics;
  if (fields === undefined) return undefined;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`${probe.name} diagnostics must be an object mapping observation keys to reasons`);
  }
  const entries = Object.entries(fields);
  if (entries.length === 0) throw new Error(`${probe.name} diagnostics must declare at least one field`);
  for (const [key, reason] of entries) {
    if (!diagnosticKey.test(key)) {
      throw new Error(`${probe.name} diagnostic ${JSON.stringify(key)} must be a top-level observation key, not a path or wildcard`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`${probe.name} diagnostic ${key} needs a non-empty reason`);
    }
    if (placeholderReasons.has(reason.trim().toLowerCase())) {
      throw new Error(`${probe.name} diagnostic ${key} needs an explanation, not ${JSON.stringify(reason)}`);
    }
  }
  return { ...fields };
}

export function separateDiagnostics(probe, observation) {
  const fields = declaredDiagnostics(probe);
  if (fields === undefined) return { value: observation, diagnostics: undefined };
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error(`${probe.name} declares diagnostics but did not return an observation object`);
  }
  const value = { ...observation };
  const diagnostics = {};
  for (const [key, reason] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${probe.name} declared diagnostic ${key} is missing from its observation`);
    }
    if (JSON.stringify(value[key]) === undefined) {
      throw new Error(`${probe.name} diagnostic ${key} must be JSON-serializable`);
    }
    diagnostics[key] = { reason, observed: value[key] };
    delete value[key];
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`${probe.name} cannot declare every observation field as diagnostics`);
  }
  return { value, diagnostics };
}

export function summarize(runs) {
  const changes = [];
  const unstable = [];
  const failures = [];
  let comparedValues = 0;
  const reference = runs[0]?.headed ?? {};
  for (const [iteration, run] of runs.entries()) {
    for (const mode of ["headed", "headless"]) {
      for (const [probe, result] of Object.entries(run[mode] ?? {})) {
        if (result.status !== "passed") failures.push({ iteration, mode, probe, error: result.error });
      }
    }
    const names = [...new Set([...Object.keys(run.headed), ...Object.keys(run.headless)])].sort();
    for (const probe of names) {
      const headed = run.headed[probe];
      const headless = run.headless[probe];
      if (!headed || !headless) {
        failures.push({ iteration, probe, error: "A browser mode did not execute this probe" });
        continue;
      }
      if (headed.status !== "passed" || headless.status !== "passed") continue;
      comparedValues += leafCount(headed.value);
      const fields = differences(headed.value, headless.value);
      if (fields.length) changes.push({ iteration, probe, fields });
      if (iteration && reference[probe]?.status === "passed") {
        const fields = differences(reference[probe].value, headed.value);
        if (fields.length) unstable.push({ iteration, mode: "headed", probe, fields });
      }
      if (iteration && runs[0].headless[probe]?.status === "passed") {
        const fields = differences(runs[0].headless[probe].value, headless.value);
        if (fields.length) unstable.push({ iteration, mode: "headless", probe, fields });
      }
    }
  }
  if (Object.keys(reference).length === 0) failures.push({ error: "No probes executed" });
  return { comparedValues, differences: changes, unstable, failures };
}
