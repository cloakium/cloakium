import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireSeat, recoverStaleSeat } from "./seat.mjs";

test("direct and Rust-invoked Node runs share an exclusive, non-stealing lease", async () => {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-seat-test-");
  const directory = path.join(root, "seat");
  try {
    const lease = await acquireSeat(directory);
    await assert.rejects(acquireSeat(directory), /never stolen/);
    await assert.rejects(recoverStaleSeat(directory), /still alive/);
    await lease.release();
    await lease.release();
    const second = await acquireSeat(directory);
    await second.release();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit stale recovery requires absence of the recorded process instance", async () => {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-seat-test-");
  const directory = path.join(root, "seat");
  try {
    await acquireSeat(directory, async pid => ({ pid, startTicks: "123" }));
    await assert.rejects(recoverStaleSeat(directory, async pid => ({ pid, startTicks: "456" })), /Owner death alone/);
    const receipt = await recoverStaleSeat(directory, async pid => ({ pid, startTicks: "456" }),
      { ownedChildrenVerifiedGone: true });
    assert.equal(receipt.recovered, true);
    assert.equal(await fs.lstat(directory).then(() => true, () => false), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
