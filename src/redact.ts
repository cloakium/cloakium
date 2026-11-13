/** Credential redaction for proxy and GeoIP diagnostics. */

const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/** `scheme://user:pass@host` → `scheme://***@host`. */
export function redactUrlCredentials(text: string): string {
  return text.replace(USERINFO, "$1***@");
}

/** Redact URL userinfo, then exact secrets of usable length. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = redactUrlCredentials(text);
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** Scrub an error's message and stack in place. */
export function scrubError<T>(error: T, secrets: readonly string[]): T {
  if (!(error instanceof Error) || secrets.length === 0) return error;
  error.message = redactSecrets(error.message, secrets);
  if (typeof error.stack === "string") error.stack = redactSecrets(error.stack, secrets);
  return error;
}
