import path from "node:path";

export const usage = `Usage: node tests/audit/run.mjs --plan ABS_JSON --output ABS_PRIVATE_DIR

Executes an explicit, versioned audit plan using local fixtures.
Browser artifacts, clients and launchers must already be selected.
Outputs are private, serial and non-overwriting. Headless never needs X.
Use cloakium-audit for inventory, plan validation, orchestration and comparison.
`;

export function parseArguments(args) {
  const options = {};
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--plan", "--output"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error("Expected --plan ABS_JSON and --output ABS_PRIVATE_DIR");
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error("Duplicate audit runner argument");
    if (!path.isAbsolute(args[index + 1])) throw new Error("Audit runner paths must be absolute");
    options[key] = path.resolve(args[index + 1]);
  }
  if (!options.plan || !options.output) throw new Error("Both --plan and --output are required");
  return options;
}
