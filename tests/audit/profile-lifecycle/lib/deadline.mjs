// Bounded promises shared by the profile-lifecycle scenarios.
//
// Every wait in this suite has a wall-clock bound and an explicit label. No
// startup sleeps and no polling loops: scenarios wait on Playwright events,
// `waitForFunction`, or transaction completion.

export function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label}: deadline ${milliseconds}ms`);
        error.code = 'deadline-exceeded';
        reject(error);
      }, milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

// Resolves to a gap instead of throwing, for surfaces where absence is expected.
export async function settle(promise, milliseconds, label) {
  try {
    return { ok: true, value: await bounded(promise, milliseconds, label) };
  } catch (error) {
    return { ok: false, error: error.message ?? String(error), code: error.code ?? null };
  }
}

export function unixSeconds(milliseconds = Date.now()) {
  return Math.floor(milliseconds / 1000);
}
