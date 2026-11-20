// Tri-state check recorder, matching the parent runner's classification:
// `passed === false` is an inconsistency, `passed === null` is a coverage gap.

export function recorder() {
  const checks = [];
  const limitations = [];
  const seen = new Set();
  const record = (name, passed, detail) => {
    if (seen.has(name)) throw new Error(`check ${name} recorded twice in one run`);
    seen.add(name);
    checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  };
  return {
    expect(name, ok, detail) {
      record(name, ok === true, detail);
      return ok === true;
    },
    unknown(name, detail) {
      record(name, null, detail);
      return null;
    },
    limit(code, detail) {
      limitations.push({ code, ...(detail === undefined ? {} : { detail }) });
    },
    checks,
    limitations
  };
}

export function finish(rec, observations, extra = {}) {
  const evaluable = rec.checks.filter((check) => check.passed !== null).length;
  const coverage = evaluable === 0 ? 'unknown' : evaluable === rec.checks.length ? 'full' : 'partial';
  return {
    observations,
    checks: rec.checks,
    limitations: rec.limitations,
    coverage,
    failed: rec.checks.filter((check) => check.passed === false).length,
    ...extra
  };
}
