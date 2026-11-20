import test from "node:test";
import assert from "node:assert/strict";
import { parseArguments } from "./cli.mjs";

test("audit runner accepts only the explicit documented paths", () => {
  assert.deepEqual(parseArguments(["--plan", "/private/plan.json", "--output", "/private/run"]),
    { plan: "/private/plan.json", output: "/private/run" });
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  for (const args of [[], ["--plan", "relative.json", "--output", "/private/run"],
    ["--plan", "/private/plan.json"], ["--plan", "/a", "--plan", "/b", "--output", "/c"],
    ["--plan", "/a", "--output", "/b", "--unrecognized", "/c"]])
    assert.throws(() => parseArguments(args));
});
