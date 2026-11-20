import { pathToFileURL } from "node:url";
import path from "node:path";
import { parseArguments, usage } from "./lib/cli.mjs";
import { safeError } from "./lib/secure-io.mjs";

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { process.stdout.write(usage); return; }
  const { runAudit } = await import("./lib/runner.mjs");
  const result = await runAudit(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify(safeError(error, "audit runner"))}\n`);
    process.exitCode = 1;
  });
}
