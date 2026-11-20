import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const sensitiveFields = /^(password|authorization|proxy-authorization|secret|access_token|refresh_token|license_key|licenseKey|privateKey)$/i;
const errorCodes = new Set([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "ETIMEDOUT", "ECONNREFUSED",
  "ECONNRESET", "EPIPE", "AUDIT_DEADLINE", "ABORT_ERR",
]);

export function redactText(input) {
  return String(input)
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:https?|socks5h?):\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|signature|credential|authorization)=)[^&\s"']*/gi, "$1[REDACTED]")
    .replace(/((?:password|license[_ -]?key|access[_ -]?token)\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]");
}

export function serializable(value, ancestors = new Set()) {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: String(value) };
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) throw new Error("Audit observation contains a cycle");
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(item => serializable(item, next));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitiveFields.test(key) ? "[REDACTED]" : serializable(item, next),
  ]));
}

export async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))
    throw new Error("Audit directory is not an owned regular directory");
  if ((stat.mode & 0o777) !== 0o700) throw new Error("Audit directory must have mode 0700");
}

export async function atomicJson(file, value, { overwrite = false } = {}) {
  await privateDirectory(path.dirname(file));
  if (!overwrite) {
    try { await fs.lstat(file); throw new Error("Refusing to overwrite audit artifact"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } else {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("Audit report is not an owned regular file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(serializable(value), null, 2)}\n`);
    await handle.sync();
    await handle.close();
    if (overwrite) await fs.rename(temporary, file);
    else {
      await fs.link(temporary, file);
      await fs.unlink(temporary);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function safeError(error, operation) {
  const message = String(error?.message ?? "");
  const category = /timeout|deadline|timed out/i.test(message) ? "timeout"
    : /closed|disconnected/i.test(message) ? "target-closed"
      : /ERR_NO_SUPPORTED_PROXIES|proxy authentication/i.test(message) ? "unsupported-proxy"
        : /protocol error/i.test(message) ? "protocol-error" : "operation-failed";
  const name = ["Error", "TypeError", "RangeError", "TimeoutError", "AbortError"].includes(error?.name)
    ? error.name : "Error";
  return {
    operation, name, category,
    ...(errorCodes.has(error?.code) ? { code: error.code } : {}),
    detail: "Raw target/driver error text omitted because it may contain credentials or target output.",
  };
}
