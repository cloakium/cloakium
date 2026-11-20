import fs from "node:fs/promises";
import path from "node:path";
import { hashFile, hashValue } from "./hashes.mjs";
import { textCommand } from "./commands.mjs";

export async function fontInventory(executable, env, command = textCommand) {
  if (!executable || !path.isAbsolute(executable))
    return { status: "unavailable", reason: "No explicit fc-list executable selected.", files: [], sha256: null };
  const text = await command(executable, ["--format", "%{file}\\n"], { env, timeoutMs: 30000 });
  const paths = [...new Set(text.trim().split("\n").filter(Boolean))].sort();
  const files = [];
  for (const file of paths) {
    if (!path.isAbsolute(file)) throw new Error("Fontconfig returned a non-absolute font path");
    const realPath = await fs.realpath(file);
    files.push({ path: realPath, sha256: await hashFile(realPath), bytes: (await fs.stat(realPath)).size });
  }
  return {
    status: files.length ? "measured" : "empty", toolPath: await fs.realpath(executable),
    toolSha256: await hashFile(executable), files, sha256: hashValue(files),
    scope: "Files visible to fontconfig in the supplied launch environment; not proof of every font used by an engine.",
  };
}
