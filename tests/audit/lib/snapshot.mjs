import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_EXTENSIONS = new Set([
  ".mjs", ".js", ".json", ".rs", ".toml", ".lock", ".md", ".html", ".css", ".txt",
]);
const BLOCKED_DIRECTORIES = new Set([
  "node_modules", "target", "reports", "evidence", ".git", ".jj",
]);
const MANIFEST_NAME = "snapshot-manifest.json";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export async function snapshotSources(sourceRoot, destination, manifest) {
  const files = validateManifest(manifest);
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(destination))
    throw new Error("snapshot: sourceRoot and destination must be absolute");
  await assertSourceRoot(sourceRoot);
  await assertFreshDestination(destination);
  try {
    for (const entry of files) {
      const source = path.join(sourceRoot, entry.path);
      const target = path.join(destination, entry.path);
      await ensureDirectory(destination, path.posix.dirname(entry.path));
      await copyVerified(sourceRoot, source, target, entry.sha256);
    }
    const manifestFileSha256 = await writeManifest(destination, files, manifest.sha256);
    return {
      directory: destination,
      files: files.length,
      sha256: manifest.sha256,
      manifestFileSha256,
      verified: true,
    };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.files))
    throw new Error("snapshot: manifest.files must be an array");
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256))
    throw new Error("snapshot: manifest.sha256 must be lowercase hex");
  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string")
      throw new Error("snapshot: manifest entry needs path and sha256");
    if (!/^[0-9a-f]{64}$/.test(entry.sha256))
      throw new Error("snapshot: manifest file sha256 must be lowercase hex");
    validateRelative(entry.path);
    if (seen.has(entry.path)) throw new Error("snapshot: duplicate manifest path");
    seen.add(entry.path);
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  if (hashValue(files) !== manifest.sha256)
    throw new Error("snapshot: manifest aggregate does not match its files");
  return files;
}

function validateRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0)
    throw new Error("snapshot: manifest path is empty");
  if (relative.includes("\0") || relative.includes("\\"))
    throw new Error("snapshot: manifest path contains a NUL or backslash");
  if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative))
    throw new Error("snapshot: manifest path is absolute");
  if (/[\u0000-\u001f]/.test(relative))
    throw new Error("snapshot: manifest path contains a control character");
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      throw new Error("snapshot: manifest path traverses or is empty");
    if (BLOCKED_DIRECTORIES.has(segment))
      throw new Error("snapshot: manifest path enters a private artifact directory");
  }
  if (segments.includes(MANIFEST_NAME))
    throw new Error("snapshot: manifest path uses the reserved snapshot manifest name");
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(relative)))
    throw new Error("snapshot: manifest path has a disallowed extension");
}

async function assertSourceRoot(sourceRoot) {
  const stat = await fs.lstat(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("snapshot: sourceRoot must be a regular directory");
}

async function assertFreshDestination(destination) {
  try {
    await fs.lstat(destination);
    throw new Error("snapshot: destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(destination);
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("snapshot: destination parent must be a regular directory");
  if (!ownedByCurrent(stat) || (stat.mode & 0o077) !== 0)
    throw new Error("snapshot: destination parent must be owned and mode 0700");
  await fs.mkdir(destination, { mode: 0o700 });
  const created = await fs.lstat(destination);
  if (!created.isDirectory() || created.isSymbolicLink() || !ownedByCurrent(created))
    throw new Error("snapshot: destination is not an owned directory");
  await fs.chmod(destination, 0o700);
}

async function ensureDirectory(root, relative) {
  if (relative === "." || relative === "") return;
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("snapshot: destination path contains a non-directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
    await fs.chmod(current, 0o700);
  }
}

async function assertSourceFile(sourceRoot, source) {
  let current = sourceRoot;
  const relative = path.relative(sourceRoot, source);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("snapshot: source path escapes sourceRoot");
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink())
      throw new Error("snapshot: symlink in source path");
  }
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error("snapshot: source is not a regular file");
  return stat;
}

async function copyVerified(sourceRoot, source, target, expected) {
  const before = await assertSourceFile(sourceRoot, source);
  const beforeHash = await hashFile(source);
  if (beforeHash !== expected)
    throw new Error("snapshot: source hash differs from manifest before copy");
  const sourceHandle = await fs.open(source, constants.O_RDONLY | NOFOLLOW);
  let targetHandle;
  try {
    const opened = await sourceHandle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("snapshot: source identity changed before copy");
    targetHandle = await fs.open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(
          buffer.subarray(written, bytesRead),
          0,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten <= 0) throw new Error("snapshot: short destination write");
        written += result.bytesWritten;
      }
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    const after = await assertSourceFile(sourceRoot, source);
    if (after.ino !== before.ino || after.dev !== before.dev ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("snapshot: source changed during copy");
    if (await hashFile(source) !== expected)
      throw new Error("snapshot: source hash changed during copy");
    await fs.chmod(target, 0o600);
    if (await hashFile(target) !== expected)
      throw new Error("snapshot: copied file hash differs from manifest");
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle.close().catch(() => {});
  }
}

async function hashFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("snapshot: hash input is not a regular file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeManifest(destination, files, sha256) {
  const document = { schema: "cloakium.audit.snapshot/1", files, sha256 };
  const temporary = path.join(
    destination,
    `.snapshot-manifest.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const manifestPath = path.join(destination, MANIFEST_NAME);
  await fs.link(temporary, manifestPath);
  await fs.unlink(temporary);
  const directory = await fs.open(destination, constants.O_RDONLY);
  await directory.sync().catch(() => {});
  await directory.close();
  return hashFile(manifestPath);
}

function ownedByCurrent(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function hashValue(value) {
  const stable = (input) =>
    Array.isArray(input)
      ? input.map(stable)
      : input && typeof input === "object"
        ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]))
        : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
