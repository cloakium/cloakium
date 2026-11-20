import fs from "node:fs/promises";
import path from "node:path";
import { privateDirectory, atomicJson } from "./secure-io.mjs";
import { processIdentity } from "./processes.mjs";

export function defaultSeatDirectory() {
  return `/tmp/opencode/cloakium-audit-seat-${process.getuid()}`;
}

async function readOwner(directory) {
  await privateDirectory(directory);
  const file = path.join(directory, "owner.json");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid()) throw new Error("Audit seat owner record is not private");
  const owner = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.startTicks))
    throw new Error("Audit seat owner identity is malformed");
  return owner;
}

export async function acquireSeat(directory = defaultSeatDirectory(), inspect = processIdentity) {
  const identity = await inspect(process.pid);
  if (!identity) throw new Error("Cannot establish audit seat process identity");
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code === "EEXIST") throw new Error("An audit seat lease exists; live or unverified leases are never stolen");
    throw error;
  });
  const stat = await fs.lstat(directory);
  try {
    await atomicJson(path.join(directory, "owner.json"), {
      pid: identity.pid, startTicks: identity.startTicks, created: new Date().toISOString(),
    });
  } catch (error) {
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
  let released = false;
  return {
    directory,
    async release() {
      if (released) return;
      const current = await fs.lstat(directory);
      const owner = await readOwner(directory);
      if (current.ino !== stat.ino || current.dev !== stat.dev || owner.pid !== identity.pid ||
          owner.startTicks !== identity.startTicks) throw new Error("Audit seat identity changed; lease was not removed");
      await fs.unlink(path.join(directory, "owner.json"));
      await fs.rmdir(directory);
      released = true;
    },
  };
}

export async function recoverStaleSeat(directory = defaultSeatDirectory(), inspect = processIdentity,
  { ownedChildrenVerifiedGone = false } = {}) {
  const owner = await readOwner(directory);
  const current = await inspect(owner.pid);
  if (current?.startTicks === owner.startTicks)
    throw new Error("Audit seat owner is still alive; refusing recovery");
  if (!ownedChildrenVerifiedGone)
    throw new Error("Owner death alone is insufficient; verify the recorded owned browser children are gone before recovery");
  const again = await readOwner(directory);
  if (JSON.stringify(owner) !== JSON.stringify(again))
    throw new Error("Audit seat identity changed during recovery");
  await fs.unlink(path.join(directory, "owner.json"));
  await fs.rmdir(directory);
  return { recovered: true, ownerInstanceAbsent: true, ownedChildrenVerifiedGone: true };
}
