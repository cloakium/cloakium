const statuses = new Set([
  "pass", "fail", "unavailable", "unsupported-by-target", "stage-needed", "inconclusive",
]);

export function checkVerdict(check) {
  if (typeof check?.name !== "string" || !check.name ||
      (typeof check.passed !== "boolean" && check.passed !== null))
    throw new Error("Every audit check requires a name and boolean/null verdict");
  if (check.status !== undefined) {
    if (!statuses.has(check.status)) throw new Error("Unknown audit check status");
    if (check.status === "pass") {
      if (check.passed !== true) throw new Error("Passing status contradicts verdict");
      return "pass";
    }
    if (check.status === "fail") {
      if (check.passed !== false) throw new Error("Failing status contradicts verdict");
      return "fail";
    }
    if (check.passed === true) throw new Error("Unavailable status cannot be a pass");
    return "unknown";
  }
  return check.passed === true ? "pass" : check.passed === false ? "fail" : "unknown";
}

export function summarizeResult(result) {
  if (!result || !Array.isArray(result.checks) || !Array.isArray(result.limitations) ||
      !Object.hasOwn(result, "observations"))
    throw new Error("Audit probe result requires observations, checks and limitations");
  const seen = new Set();
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const check of result.checks) {
    if (seen.has(check.name)) throw new Error("A probe emitted a duplicate check name");
    seen.add(check.name);
    counts[checkVerdict(check)]++;
  }
  const status = counts.fail ? "observed-inconsistency"
    : counts.unknown || result.limitations.length || !result.checks.length
      ? "observed-with-limitations" : "observed";
  return { status, counts };
}

export async function bounded(work, milliseconds, operation) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
    throw new Error("Audit deadline must be positive integer milliseconds");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${operation}: deadline exceeded`);
          error.code = "AUDIT_DEADLINE";
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
