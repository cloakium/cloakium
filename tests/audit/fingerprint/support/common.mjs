// Shared plumbing for the independent Cloakium fingerprint behaviour probes.
//
// A probe never mutates page state: it navigates the supplied page to a local
// loopback origin, replaces the document with self-contained HTML (the origin is
// retained), reads public Web APIs, and reports raw observations plus tri-state
// checks. `passed: null` means "not evaluable on this host" and must never be
// counted as a pass by the harness.

export const DEFAULT_BUDGET_MS = 15_000;
export const MAX_BUDGET_MS = 20_000;

export const BLANK_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>cloakium probe</title></head><body></body></html>';

// Structured check recorder. `expect` is an evaluable verdict; `unknown` records
// an unavailable surface without inventing a verdict; `limit` explains why.
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
    limitations,
  };
}

// Coverage is derived, never asserted: full when every declared check was
// evaluable, partial when some surface was missing, unknown when none was.
export function finish(rec, observations, extra = {}) {
  const evaluable = rec.checks.filter((check) => check.passed !== null).length;
  const coverage =
    evaluable === 0 ? 'unknown' : evaluable === rec.checks.length ? 'full' : 'partial';
  return {
    observations,
    checks: rec.checks,
    limitations: rec.limitations,
    coverage,
    failed: rec.checks.filter((check) => check.passed === false).length,
    ...extra,
  };
}

// Use HTTP navigation; setContent compatibility is measured separately.
export async function prepare(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  await page.evaluate(() => {
    document.title = 'cloakium probe';
    document.body.replaceChildren();
  });
}

export async function newProbePage(context, base) {
  const page = await context.newPage();
  try {
    await prepare(page, base);
  } catch (error) {
    await closeQuietly(page);
    throw error;
  }
  return page;
}

export async function closeQuietly(page) {
  try {
    await page.close();
  } catch {
    /* a page that is already gone is not a probe failure */
  }
}

// Races a promise against a wall-clock bound and always clears the timer.
export function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Resolves to a sentinel instead of throwing, for surfaces where absence is a
// coverage gap rather than a defect.
export async function settle(promise, ms, label) {
  try {
    return { ok: true, value: await bounded(promise, ms, label) };
  } catch (error) {
    return { ok: false, error: error.message ?? String(error) };
  }
}

export function round(value, digits = 6) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : value;
}

export function unique(values) {
  return [...new Set(values)];
}

// True when every entry of `names` exists exactly once and nothing else does.
export function sameSet(actual, expected) {
  const left = unique([...actual].sort());
  const right = unique([...expected].sort());
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const ORIGIN_FAILURE = /(navigat|goto|Target page|context or browser has been closed)/i;
