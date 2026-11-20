// Shared helpers for the additional audit probes.
//
// A probe only reads public Web APIs and writes its own fixture DOM. Checks are
// tri-state: `passed: null` means the surface was unavailable and must never be
// counted as a pass. `coverage` is derived from the checks, never asserted.

export const MAX_TIMEOUT_MS = 45_000;

export const STATUS = {
  pass: "pass",
  fail: "fail",
  unavailable: "unavailable",
  coverageUnknown: "inconclusive",
  unsupported: "unsupported-by-target",
};

export function recorder() {
  const checks = [];
  const limitations = [];
  const seen = new Set();
  const add = (name, passed, status, detail) => {
    if (seen.has(name)) throw new Error(`check ${name} recorded twice`);
    seen.add(name);
    checks.push({ name, passed, status, ...(detail === undefined ? {} : { detail }) });
  };
  return {
    expect(name, ok, detail) {
      add(name, ok === true, ok === true ? STATUS.pass : STATUS.fail, detail);
      return ok === true;
    },
    unknown(name, status, detail) {
      add(name, null, status, detail);
      return null;
    },
    limit(code, detail) {
      limitations.push({ code, ...(detail === undefined ? {} : { detail }) });
    },
    checks,
    limitations,
  };
}

export function finish(rec, observations, extra = {}) {
  const evaluable = rec.checks.filter((check) => check.passed !== null).length;
  const coverage =
    evaluable === 0 ? "unknown" : evaluable === rec.checks.length ? "full" : "partial";
  return {
    observations,
    checks: rec.checks,
    limitations: rec.limitations,
    coverage,
    failed: rec.checks.filter((check) => check.passed === false).length,
    ...extra,
  };
}

export async function prepare(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await page.evaluate(() => {
    document.title = "cloakium additional probe";
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
    /* an already-closed page is not a probe failure */
  }
}

// Use the harness-supplied page when present; otherwise create and own one.
export async function acquirePage({ page, context, origin }) {
  if (page) {
    await prepare(page, origin);
    return { page, owned: false };
  }
  const created = await context.newPage();
  try {
    await prepare(created, origin);
  } catch (error) {
    await closeQuietly(created);
    throw error;
  }
  return { page: created, owned: true };
}

export function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function settle(promise, ms, label) {
  try {
    return { ok: true, value: await bounded(promise, ms, label) };
  } catch (error) {
    return { ok: false, error: error.message ?? String(error) };
  }
}

// Remaining wall-clock budget for one probe, clamped to its own bound.
export function remaining(deadline, fallbackMs) {
  if (!Number.isFinite(deadline)) return fallbackMs;
  return Math.max(1_000, Math.min(fallbackMs, deadline - Date.now()));
}

export function assertBudget(deadline, probeId) {
  if (Number.isFinite(deadline) && deadline - Date.now() < 1_000) {
    throw new Error(`${probeId} has less than 1000 ms of caller deadline remaining`);
  }
}

export function round(value, digits = 6) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : value;
}

export function unique(values) {
  return [...new Set(values)];
}

// FNV-1a over the raw bytes of a typed array or string. Used for repeat
// comparisons only; it is not a cryptographic digest.
export function fnv(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sameNumber(left, right, tolerance = 1e-6) {
  return (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isFinite(left) &&
    Math.abs(left - right) <= tolerance
  );
}

export function closeTo(value, expected, tolerance) {
  return sameNumber(value, expected, tolerance);
}
