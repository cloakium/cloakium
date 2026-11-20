import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned process id");
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), state: fields[0], startTicks: fields[19] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

async function children(pid) {
  const result = new Set();
  const errors = [];
  let threads;
  try { threads = await fs.readdir(`/proc/${pid}/task`); }
  catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) errors.push(error.code ?? "READ_ERROR");
    return { pids: [], errors };
  }
  for (const thread of threads.filter(value => /^\d+$/.test(value))) {
    try {
      const text = await fs.readFile(`/proc/${pid}/task/${thread}/children`, "utf8");
      for (const value of text.trim().split(/\s+/).filter(Boolean)) result.add(Number(value));
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) errors.push(error.code ?? "READ_ERROR");
    }
  }
  return { pids: [...result], errors };
}

export function createProcessTracker(rootPid, dependencies = {}) {
  const inspect = dependencies.inspect ?? processIdentity;
  const descendants = dependencies.children ?? children;
  const signal = dependencies.signal ?? ((pid, name) => process.kill(pid, name));
  const tracked = new Map();
  const limitations = new Set();
  const excluded = dependencies.excludeIdentities ?? new Set();
  let rootInstance;
  let rootRejected = false;
  return {
    async sample() {
      const queue = [rootPid, ...tracked.values()].map(row => typeof row === "number" ? row : row.pid);
      const visited = new Set();
      while (queue.length) {
        const pid = queue.shift();
        if (visited.has(pid)) continue;
        if (pid === rootPid && rootRejected) continue;
        visited.add(pid);
        try {
          const identity = await inspect(pid);
          if (!identity) {
            if (pid === rootPid && !rootInstance) {
              rootRejected = true;
              limitations.add("Owned root was unavailable before its process identity could be established.");
            }
            continue;
          }
          if (pid === rootPid) {
            if (rootInstance && identity.startTicks !== rootInstance) continue;
            rootInstance = identity.startTicks;
          } else {
            const previous = [...tracked.values()].find(row => row.pid === pid);
            if (previous && previous.startTicks !== identity.startTicks) continue;
          }
          const key = `${pid}:${identity.startTicks}`;
          if (!excluded.has(key)) tracked.set(key, identity);
          const found = await descendants(pid);
          for (const code of found.errors) limitations.add(`Process-tree read unavailable: ${code}`);
          queue.push(...found.pids);
        } catch {
          if (pid === rootPid && !rootInstance) rootRejected = true;
          limitations.add("Owned process metadata could not be sampled.");
        }
      }
      return { identities: [...tracked.values()], limitations: [...limitations] };
    },
    async remaining() {
      const result = [];
      for (const identity of tracked.values()) {
        try {
          const current = await inspect(identity.pid);
          if (current && current.startTicks === identity.startTicks && current.state !== "Z")
            result.push({ ...identity, verification: "same-instance" });
        } catch {
          result.push({ ...identity, verification: "unverified" });
        }
      }
      return result;
    },
    async terminate(name) {
      const sent = [];
      for (const identity of [...tracked.values()].reverse()) {
        let current;
        try { current = await inspect(identity.pid); } catch { continue; }
        if (!current || current.startTicks !== identity.startTicks || current.state === "Z") continue;
        try { signal(identity.pid, name); sent.push(identity.pid); }
        catch (error) { if (!["ESRCH", "ENOENT"].includes(error.code)) limitations.add("Owned process signal failed."); }
      }
      return sent;
    },
    async waitGone(milliseconds = 5000) {
      const until = Date.now() + milliseconds;
      while (true) {
        const remaining = await this.remaining();
        if (!remaining.length || Date.now() >= until) return remaining;
        await delay(Math.min(50, Math.max(1, until - Date.now())));
      }
    },
    get limitations() { return [...limitations]; },
  };
}

export async function createChildLease(parentPid = process.pid, dependencies = {}) {
  const baseline = createProcessTracker(parentPid, dependencies);
  const before = await baseline.sample();
  if (before.limitations.length || !before.identities.some(row => row.pid === parentPid))
    throw new Error("Cannot establish the owned parent process tree");
  const excludeIdentities = new Set(before.identities.map(row => `${row.pid}:${row.startTicks}`));
  return createProcessTracker(parentPid, { ...dependencies, excludeIdentities });
}
