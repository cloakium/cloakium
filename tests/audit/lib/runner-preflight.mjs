import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hashFile, hashValue } from "./hashes.mjs";
import { assertSandboxArguments } from "./browser.mjs";

const safeId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const absolute = value => typeof value === "string" && path.isAbsolute(value);
const hasSecrets = /(?:https?|socks5h?):\/\/[^/\s:@]+:[^/\s@]+@|--(?:license[-_]?key|access[-_]?token|password)(?:=|$)/i;
const secretField = /^(password|authorization|proxy-authorization|secret|access_token|refresh_token|license_key|licenseKey|privateKey|env|processEnv)$/i;

function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown or malformed audit plan fields");
}

function rejectSecrets(value) {
  if (typeof value === "string" && (hasSecrets.test(value) || /\bBearer\s+\S+/i.test(value)))
    throw new Error("Credentials are forbidden in audit configuration");
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (secretField.test(key)) throw new Error("Credential and arbitrary environment fields are forbidden");
      rejectSecrets(item);
    }
}

export function preflightPlan(plan) {
  keys(plan, ["schema", "id", "environment", "targets", "configurations"]);
  if (plan.schema !== "cloakium.audit.plan/1" || !safeId(plan.id)) throw new Error("Unsupported audit plan");
  keys(plan.environment, ["id", "locale", "timezoneId", "fontconfigFile", "fontconfigPath", "fontManifestSha256", "display", "notes"]);
  if (!safeId(plan.environment.id)) throw new Error("Invalid environment id");
  Intl.getCanonicalLocales(plan.environment.locale);
  new Intl.DateTimeFormat("en-US", { timeZone: plan.environment.timezoneId });
  keys(plan.environment.display, ["kind", "width", "height", "depth", "dpi", "windowManager",
    "displayName", "xauthorityPath", "ownershipManifestPath"]);
  const targets = new Set();
  if (!Array.isArray(plan.targets) || !plan.targets.length) throw new Error("Audit targets are required");
  for (const target of plan.targets) {
    keys(target, ["id", "label", "artifactPath", "executablePath", "clientModule", "layer", "identity", "args", "headlessArgs", "headedArgs"]);
    if (!safeId(target.id) || targets.has(target.id) || !["artifactPath", "executablePath", "clientModule"].every(key => absolute(target[key])))
      throw new Error("Invalid or duplicate explicit audit target");
    targets.add(target.id);
    for (const args of [target.args ?? [], target.headlessArgs ?? [], target.headedArgs ?? []]) {
      assertSandboxArguments(args);
      if (args.some(arg => hasSecrets.test(arg))) throw new Error("Credentials are forbidden in audit plan arguments");
    }
  }
  const configurations = new Set();
  if (!Array.isArray(plan.configurations) || !plan.configurations.length) throw new Error("Audit configurations are required");
  for (const config of plan.configurations) {
    keys(config, ["id", "targetId", "mode", "iteration", "profileId", "seed", "args", "contextOptions",
      "suites", "probeIds", "scenarioIds", "suiteOptions", "probeConfig"]);
    if (!safeId(config.id) || configurations.has(config.id) || !targets.has(config.targetId) ||
        !["headed", "headless"].includes(config.mode) || !safeId(config.profileId) ||
        !Number.isSafeInteger(config.iteration) || config.iteration < 1 ||
        !Array.isArray(config.suites) || !config.suites.length || new Set(config.suites).size !== config.suites.length)
      throw new Error("Invalid or duplicate audit configuration");
    configurations.add(config.id);
    assertSandboxArguments(config.args ?? []);
    if ((config.args ?? []).some(arg => hasSecrets.test(arg))) throw new Error("Credentials are forbidden in audit configuration arguments");
    rejectSecrets(config.contextOptions);
    rejectSecrets(config.suiteOptions);
    rejectSecrets(config.probeConfig);
  }
  return plan;
}

async function identify(file, artifact = false) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error("Selected artifact or launcher is not an executable regular file");
  const handle = await fs.open(file, "r");
  const header = Buffer.alloc(64);
  let count;
  try { count = (await handle.read(header, 0, 64, 0)).bytesRead; } finally { await handle.close(); }
  const elf = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const script = header.subarray(0, 2).toString() === "#!";
  if ((!elf && !script) || (artifact && !elf)) throw new Error("Engine artifact must be ELF; trusted launchers must be ELF or executable scripts");
  if (elf && (process.platform !== "linux" || count < 64 || header[4] !== 2 || header[5] !== 1 ||
      ![2, 3].includes(header.readUInt16LE(16)) ||
      header.readUInt16LE(18) !== (process.arch === "x64" ? 62 : process.arch === "arm64" ? 183 : -1)))
    throw new Error("Selected ELF is not a supported native Linux executable");
  return { path: file, realPath: await fs.realpath(file), bytes: stat.size, kind: elf ? "elf" : "script", sha256: await hashFile(file) };
}

export async function targetDigests(targets) {
  const result = [];
  const cache = new Map();
  const get = async (file, artifact) => {
    const key = `${artifact}:${file}`;
    if (!cache.has(key)) cache.set(key, await identify(file, artifact));
    return cache.get(key);
  };
  for (const target of targets) result.push({
    id: target.id, artifact: await get(target.artifactPath, true), launcher: await get(target.executablePath, false),
  });
  return result;
}

export async function additionalExecutableDigests(plan) {
  const files = new Set();
  for (const configuration of plan.configurations) {
    const selected = configuration.probeConfig?.provenanceFiles;
    if (selected === undefined) continue;
    if (!Array.isArray(selected) || selected.some(file => !absolute(file)))
      throw new Error("Additional executable provenance requires explicit absolute paths");
    for (const file of selected) files.add(file);
  }
  const result = [];
  for (const file of [...files].sort()) result.push(await identify(file, false));
  return result;
}

export async function baseEnvironment(plan, output) {
  const file = path.join(output, "environment.json");
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.id !== plan.environment.id || value.locale !== plan.environment.locale ||
        value.timezoneId !== plan.environment.timezoneId || !value.resolved) throw new Error("Preflight environment provenance differs from plan");
    return value;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const spec = plan.environment;
  const values = Object.fromEntries((await fs.readFile("/etc/os-release", "utf8").catch(() => ""))
    .split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "").replaceAll('\\"', '"')];
    }));
  const zoneinfoPath = `/usr/share/zoneinfo/${spec.timezoneId}`;
  const fontconfig = spec.fontconfigFile ? {
    declaredFile: spec.fontconfigFile, realPath: await fs.realpath(spec.fontconfigFile), exists: true,
    sha256: await hashFile(spec.fontconfigFile),
    ...(spec.fontconfigPath ? { declaredPath: spec.fontconfigPath, pathRealPath: await fs.realpath(spec.fontconfigPath), pathExists: true } : {}),
  } : null;
  return {
    ...spec,
    resolved: {
      os: { id: values.ID || "unknown", name: values.NAME || "unknown", versionId: values.VERSION_ID || "unknown",
        prettyName: values.PRETTY_NAME || "unknown", buildId: values.BUILD_ID || "unknown",
        kernel: os.release(), arch: process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch },
      timezone: { id: spec.timezoneId, zoneinfoPath, exists: await fs.stat(zoneinfoPath).then(value => value.isFile(), () => false) },
      ...(fontconfig ? { fontconfig } : {}),
      display: { kind: spec.display.kind },
      locale: { declared: spec.locale, source: "plan", processLang: "C.UTF-8", processLcAll: "C.UTF-8" },
      environment: { mode: "cleared+allowlist", inherited: false, appliedKeys: [], displayKeys: [], headlessDisplay: "not-set" },
    },
    diagnostics: { source: "direct-node-preflight", environmentPlanSha256: hashValue(spec) },
  };
}
