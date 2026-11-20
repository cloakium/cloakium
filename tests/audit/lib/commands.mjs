import { spawn } from "node:child_process";

export function textCommand(executable, args, { timeoutMs = 45000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "ignore"], shell: false });
    const chunks = [];
    let size = 0;
    let failure;
    const stop = error => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(Object.assign(new Error("Audit helper deadline exceeded"), {
      code: "AUDIT_DEADLINE",
    })), timeoutMs);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) stop(new Error("Audit helper exceeded its JSON protocol limit"));
      else chunks.push(chunk);
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || signal) return reject(new Error("Audit helper failed; raw diagnostics omitted"));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function jsonCommand(executable, args, options = {}) {
  const text = await textCommand(executable, args, options);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
    return value;
  } catch { throw new Error("Audit helper returned an invalid JSON protocol response"); }
}
