import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function hashFile(file) {
  const real = await fs.realpath(file);
  if (!(await fs.stat(real)).isFile()) throw new Error("Hash input must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(real)) hash.update(chunk);
  return hash.digest("hex");
}

export function hashValue(value) {
  const stable = input => Array.isArray(input) ? input.map(stable)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])])) : input;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export async function sourceManifest(directory, { allFiles = false } = {}) {
  const files = [];
  const walk = async (current, relative = "") => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "target", "reports", "evidence"].includes(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Audit sources must not contain symlinks");
      if (entry.isDirectory()) await walk(absolute, name);
      else if (entry.isFile() && (allFiles || /\.(?:mjs|json|rs|toml)$/.test(entry.name)))
        files.push({ path: name, sha256: await hashFile(absolute) });
    }
  };
  await walk(directory);
  return { files, sha256: hashValue(files) };
}

export async function loadDriver(modulePath) {
  const real = await fs.realpath(modulePath);
  const packageFile = path.join(path.dirname(real), "package.json");
  const metadata = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (metadata.name !== "playwright-core")
    throw new Error("Audit client must explicitly select the playwright-core entry module");
  const module = await import(pathToFileURL(real).href);
  if (!module.chromium?.launchServer || !module.chromium?.connect)
    throw new Error("Selected client does not expose the required Chromium server API");
  const marker = path.join(path.dirname(real), "CLOAKIUM-PATCHES.json");
  let patchManifestSha256 = null;
  try { patchManifestSha256 = await hashFile(marker); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifest = await sourceManifest(path.dirname(real), { allFiles: true });
  return {
    chromium: module.chromium,
    metadata: {
      version: metadata.version, path: real, sha256: manifest.sha256,
      packageSha256: await hashFile(packageFile), patchManifestSha256,
    },
  };
}
