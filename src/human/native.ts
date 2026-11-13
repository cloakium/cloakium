/**
 * Helpers for passing through Playwright's own methods after this package has
 * wrapped them.
 */

/** Value of the unpatched function, stored on a wrapper by `patchMethod`. */
export const NATIVE = Symbol.for("cloakium.human.native");

/** `fn` without the humanize wrapper, when it is one of our wrappers. */
export function nativeOf<F extends (...args: never[]) => unknown>(fn: F): F {
  const native = (fn as unknown as { [NATIVE]?: F })[NATIVE];
  return native ?? fn;
}
