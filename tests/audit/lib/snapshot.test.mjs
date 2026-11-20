import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile, hashValue, sourceManifest } from "./hashes.mjs";
import { snapshotSources } from "./snapshot.mjs";

async function scratch(tag) {
  const root = await fs.mkdtemp(`/tmp/opencode/cloakium-snapshot-${tag}-`);
  await fs.chmod(root, 0o700);
  return root;
}

async function write(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content);
  await fs.chmod(file, 0o600);
}

async function manifestFor(root, paths) {
  const files = [];
  for (const relative of [...paths].sort()) {
    files.push({ path: relative, sha256: await hashFile(path.join(root, relative)) });
  }
  return { files, sha256: hashValue(files) };
}

async function destination(root, name = "bundle") {
  const parent = path.join(root, "out");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  return path.join(parent, name);
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test("copies manifest files privately and self-verifies", async () => {
  const root = await scratch("copy");
  try {
    await write(root, "lib/a.mjs", "export const a = 1;\n");
    await write(root, "data/b.json", "{\"b\":2}\n");
    const manifest = await sourceManifest(root);
    const target = await destination(root);
    const result = await snapshotSources(root, target, manifest);
    assert.equal(result.verified, true);
    assert.equal(result.files, 2);
    assert.equal(result.sha256, manifest.sha256);
    assert.equal(await fs.readFile(path.join(target, "lib/a.mjs"), "utf8"), "export const a = 1;\n");
    assert.equal((await fs.stat(path.join(target, "lib/a.mjs"))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(target, "lib"))).mode & 0o777, 0o700);
    const document = JSON.parse(await fs.readFile(path.join(target, "snapshot-manifest.json"), "utf8"));
    assert.equal(document.schema, "cloakium.audit.snapshot/1");
    assert.deepEqual(document.files, manifest.files);
    assert.equal(hashValue(document.files), document.sha256);
    assert.equal(result.manifestFileSha256, await hashFile(path.join(target, "snapshot-manifest.json")));
  } finally {
    await cleanup(root);
  }
});

test("source mutation after manifest is rejected and cleaned", async () => {
  const root = await scratch("mutate");
  try {
    await write(root, "a.mjs", "original\n");
    const manifest = await manifestFor(root, ["a.mjs"]);
    await write(root, "a.mjs", "changed\n");
    const target = await destination(root);
    await assert.rejects(snapshotSources(root, target, manifest), /differs from manifest/);
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  } finally {
    await cleanup(root);
  }
});

test("symlink file and symlink ancestor are rejected", async () => {
  const root = await scratch("symlink");
  try {
    await write(root, "real.mjs", "real\n");
    await fs.symlink(path.join(root, "real.mjs"), path.join(root, "link.mjs"));
    const linkManifest = await manifestFor(root, ["link.mjs"]);
    const target = await destination(root);
    await assert.rejects(snapshotSources(root, target, linkManifest), /symlink/);

    const ancestorRoot = await scratch("ancestor");
    try {
      await write(ancestorRoot, "real/a.mjs", "a\n");
      await fs.symlink(path.join(ancestorRoot, "real"), path.join(ancestorRoot, "dir"));
      const ancestorManifest = {
        files: [{ path: "dir/a.mjs", sha256: await hashFile(path.join(ancestorRoot, "real/a.mjs")) }],
        sha256: "",
      };
      ancestorManifest.sha256 = hashValue(ancestorManifest.files);
      const ancestorTarget = await destination(ancestorRoot);
      await assert.rejects(snapshotSources(ancestorRoot, ancestorTarget, ancestorManifest), /symlink/);
    } finally {
      await cleanup(ancestorRoot);
    }
  } finally {
    await cleanup(root);
  }
});

test("path traversal and disallowed paths are rejected", async () => {
  const root = await scratch("paths");
  try {
    await write(root, "a.mjs", "a\n");
    const base = { path: "a.mjs", sha256: await hashFile(path.join(root, "a.mjs")) };
    let index = 0;
    for (const candidate of [
      { files: [{ ...base, path: "../escape.mjs" }] },
      { files: [{ ...base, path: "target/a.mjs" }] },
      { files: [{ ...base, path: ".env" }] },
      { files: [{ ...base, path: "snapshot-manifest.json" }] },
    ]) {
      candidate.sha256 = hashValue(candidate.files);
      const target = await destination(root, `bundle-${index++}`);
      await assert.rejects(snapshotSources(root, target, candidate), /manifest path/);
      await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    }
  } finally {
    await cleanup(root);
  }
});

test("preexisting destination and tampered aggregate are refused", async () => {
  const root = await scratch("pre");
  try {
    await write(root, "a.mjs", "a\n");
    const manifest = await manifestFor(root, ["a.mjs"]);
    const target = await destination(root);
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, "sentinel"), "keep\n");
    await assert.rejects(snapshotSources(root, target, manifest), /already exists/);
    assert.equal(await fs.readFile(path.join(target, "sentinel"), "utf8"), "keep\n");
    await fs.rm(target, { recursive: true, force: true });

    const tampered = { ...manifest, sha256: "0".repeat(64) };
    await assert.rejects(snapshotSources(root, target, tampered), /aggregate/);
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  } finally {
    await cleanup(root);
  }
});

test("empty manifest is valid and produces a self-verifying manifest", async () => {
  const root = await scratch("empty");
  try {
    const target = await destination(root);
    const manifest = { files: [], sha256: hashValue([]) };
    const result = await snapshotSources(root, target, manifest);
    assert.equal(result.verified, true);
    assert.equal(result.files, 0);
    const document = JSON.parse(await fs.readFile(path.join(target, "snapshot-manifest.json"), "utf8"));
    assert.deepEqual(document.files, []);
    assert.equal(document.sha256, manifest.sha256);
  } finally {
    await cleanup(root);
  }
});
