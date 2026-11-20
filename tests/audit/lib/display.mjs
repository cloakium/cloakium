import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hashes.mjs";
import { privateDirectory } from "./secure-io.mjs";
import { jsonCommand } from "./commands.mjs";

export function displayArguments(args, mode, display) {
  return args.map(arg => {
    if (!arg.includes("{display.")) return arg;
    if (mode !== "headed" || !display?.owned)
      throw new Error("Display placeholders are only valid with an owned headed display");
    const resolved = arg.replaceAll("{display.display}", display.display)
      .replaceAll("{display.xauthorityPath}", display.xauthorityPath)
      .replaceAll("{display.stateDir}", display.stateDir);
    if (resolved.includes("{display.")) throw new Error("Unknown display placeholder");
    return resolved;
  });
}

export async function verifiedDisplay(helper, directory, command = jsonCommand) {
  await privateDirectory(directory);
  const file = path.join(directory, "display.json");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Display manifest must be a private owned regular file");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  if (manifest.schema !== "cloakium.audit.display/1" || manifest.owned !== true ||
      manifest.authEnforced !== true || !/^:\d+$/.test(manifest.display) ||
      manifest.xauthorityPath !== path.join(directory, "Xauthority"))
    throw new Error("Display manifest does not describe the required owned display");
  const status = await command(helper, ["status", "--state-dir", directory], { timeoutMs: 20000 });
  if (!status.xvfbAlive || !status.wmAlive || !status.socketOwned || !status.socketIdentityMatched || !status.reachable ||
      status.display !== manifest.display || status.xvfbPid !== manifest.xvfbPid)
    throw new Error("Owned display is not live, authenticated and reachable");
  return { ...manifest, stateDir: directory, manifestSha256: await hashFile(file) };
}

export function createDisplayManager({ settings, helper, output }, dependencies = {}) {
  const command = dependencies.command ?? jsonCommand;
  const verify = dependencies.verify ?? verifiedDisplay;
  let display;
  let stateDir;
  let started = false;
  let closing;
  return {
    async get(mode) {
      if (mode === "headless") return null;
      if (display) return display;
      if (!helper) throw new Error("Headed audit requires the explicit private-display helper");
      if (settings.kind === "managed") {
        stateDir = path.join(output, "display");
        await privateDirectory(stateDir);
        started = true;
        await command(helper, ["start", "--state-dir", stateDir,
          "--width", String(settings.width), "--height", String(settings.height),
          "--depth", String(settings.depth), "--dpi", String(settings.dpi),
          "--window-manager", settings.windowManager], { timeoutMs: 60000 });
      } else if (settings.kind === "external-owned") {
        if (!settings.ownershipManifestPath) throw new Error("An external display needs its ownership manifest");
        stateDir = path.dirname(settings.ownershipManifestPath);
      } else throw new Error("Unknown private display policy");
      display = await verify(helper, stateDir, command);
      for (const key of ["width", "height", "depth", "dpi"])
        if (display.screen[key] !== settings[key]) throw new Error("Owned display differs from the declared plan");
      if (display.windowManager !== settings.windowManager)
        throw new Error("Owned display window manager differs from the declared plan");
      return display;
    },
    async close() {
      if (!closing) closing = (async () => {
        if (!started) return { managed: false, closed: true, externallyOwned: !!display };
        const receipt = await command(helper, ["stop", "--state-dir", stateDir], { timeoutMs: 45000 });
        return { managed: true, closed: receipt.stopped === true && receipt.socketRemoved === true &&
          receipt.stateRemoved === true, receipt };
      })();
      return closing;
    },
  };
}
