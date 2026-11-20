import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fontInventory } from "./fonts.mjs";

test("font provenance hashes the actual unique font bytes under the controlled environment", async () => {
  const root = await fs.mkdtemp("/tmp/opencode/cloakium-audit-fonts-");
  try {
    const file = path.join(root, "fixture-font.bin");
    await fs.writeFile(file, "original fixture, not a real font");
    const env = { FONTCONFIG_FILE: "/fixture/fonts.conf" };
    const command = async (exe, args, options) => {
      assert.equal(exe, process.execPath);
      assert.deepEqual(args, ["--format", "%{file}\\n"]);
      assert.equal(options.env, env);
      return `${file}\n${file}\n`;
    };
    const first = await fontInventory(process.execPath, env, command);
    assert.equal(first.files.length, 1);
    await fs.appendFile(file, " changed");
    const second = await fontInventory(process.execPath, env, command);
    assert.notEqual(first.sha256, second.sha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing font inventory cannot be labelled measured", async () => {
  assert.equal((await fontInventory(null, {})).status, "unavailable");
});
