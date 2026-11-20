/**
 * Source guard for the public audit families this repository owns.
 *
 * Everything under tests/audit/{fingerprint,network,request-paths,wire-identity,
 * extended-network,browser-contracts,profile-lifecycle} and tools/audit-h3-lab
 * must stay reproducible from public standards: no private runtime paths, no
 * credential-shaped literals, no captured artifact hashes, no page-state
 * overrides, no external origins and no sandbox weakening.
 *
 * Run standalone: `node selfcheck/sources.mjs`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(AUDIT_ROOT, "..", "..");
const H3_ROOT = path.join(REPO_ROOT, "tools", "audit-h3-lab");
const MAX_LINES = 500;
const MAX_FILES = 500;

const OWNED = [
  "fingerprint", "network", "request-paths", "wire-identity",
  "extended-network", "browser-contracts", "profile-lifecycle"
];

const SKIP_DIRECTORIES = new Set(["node_modules", "target", "artifacts", "reports"]);
const TEXT = new Set([".mjs", ".js", ".json", ".md", ".rs", ".toml", ".lock", ".html"]);

const SELF = "network/selfcheck/sources.mjs";

// Guard files legitimately name the patterns they forbid.
const GUARD_FILES = new Set([
  SELF,
  "browser-contracts/selfcheck.mjs",
  "fingerprint/tests/contract.test.mjs",
  "request-paths/selfcheck/syntax.mjs"
]);

// Files where a sandbox token is a guard or a documentation note, not a launch.
const SANDBOX_ALLOWED = new Set([
  "profile-lifecycle/lib/flags.mjs",
  "profile-lifecycle/lib/lab.mjs",
  "profile-lifecycle/tests/lib.test.mjs",
  "profile-lifecycle/tests/contract.test.mjs",
  "profile-lifecycle/scenarios/launch-contract.mjs",
  "request-paths/selfcheck/browser.mjs",
  ...GUARD_FILES
]);

// Reserved/documentation names that are never resolved or contacted.
const ALLOWED_HOSTS = new Set([
  "127.0.0.1", "localhost", "[::1]", "::1", "lab.test", "example.invalid",
  "example.com", "doh.lab.invalid", "www.w3.org"
]);

// Placeholder authority used by pure-function tests (`http://x`, `http://host`).
const PLACEHOLDER_HOSTS = new Set(["x", "h", "u", "p", "host"]);

const RULES = [
  { name: "private runtime path", pattern: /\/opt\/cloakbrowser|pro-runtime-cache|cloakbrowser-pro/i },
  { name: "user home path", pattern: /\/home\/[a-z][a-z0-9._-]*\//i },
  { name: "root path", pattern: /\/root\/|CLOAKBROWSER_PRIVATE/ },
  { name: "product reference label", pattern: /cloakbrowser|CloakBrowser|CloakPro\b/i },
  { name: "credential-shaped literal", pattern: /\bcb_[A-Za-z0-9_-]{4,}/ },
  { name: "captured artifact hash", pattern: /\b[0-9a-f]{40,64}\b/, skipLockFiles: true },
  { name: "page-state override", pattern: /Function\.prototype\.[A-Za-z]+\s*=(?!=)|Object\.defineProperty\(\s*navigator|navigator\.[A-Za-z]+\s*=(?!=)/ },
  { name: "init-script injection", pattern: /addInitScript|evaluateOnNewDocument/ },
  { name: "server certificate bypass", pattern: /ignore-certificate-errors(?!-spki-list)/, allowDocs: true }
];

async function walk(root, base = "") {
  const rows = [];
  for (const entry of await readdir(path.join(root, base), { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      rows.push(...(await walk(root, relative)));
    } else if (TEXT.has(path.extname(entry.name))) {
      rows.push(relative);
    }
  }
  return rows;
}

/** Host portion of every http(s) URL literal, with template/format holes removed. */
export function remoteHosts(source) {
  // Serialise templates and Rust format strings away first: a hole is not a host.
  const scrubbed = source.replace(/\$\{[^}]*\}/g, "").replace(/\{[^}]*\}/g, "");
  const hosts = [];
  for (const match of scrubbed.matchAll(/https?:\/\/([^\s"'`/<>)]+)/g)) {
    const authority = match[1].split("@").pop();
    const host = authority.replace(/:\d*$/, "").replace(/:$/, "");
    if (!host || PLACEHOLDER_HOSTS.has(host)) continue;
    if (!ALLOWED_HOSTS.has(host)) hosts.push(host);
  }
  return hosts;
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false });
    process.stdout.write(`FAIL ${name} :: ${error.message}\n`);
  }
}

const auditFiles = [];
for (const family of OWNED) {
  for (const file of await walk(path.join(AUDIT_ROOT, family))) auditFiles.push(`${family}/${file}`);
}
const h3Files = (await walk(H3_ROOT)).map((file) => `h3:${file}`);
const allFiles = [...auditFiles, ...h3Files];

const sources = new Map();
for (const file of auditFiles) {
  sources.set(file, await readFile(path.join(AUDIT_ROOT, file), "utf8"));
}
for (const file of h3Files) {
  sources.set(file, await readFile(path.join(H3_ROOT, file.slice(3)), "utf8"));
}

await check(`file count stays bounded (${allFiles.length} <= ${MAX_FILES})`, () => {
  if (allFiles.length > MAX_FILES) throw new Error(`${allFiles.length} files`);
});

await check(`no file exceeds ${MAX_LINES} lines`, () => {
  const offenders = [];
  for (const [file, source] of sources) {
    if (file.endsWith(".lock")) continue; // generated dependency lockfile
    const lines = source.split("\n").length;
    if (lines > MAX_LINES) offenders.push(`${file}=${lines}`);
  }
  if (offenders.length) throw new Error(offenders.join(", "));
});

for (const rule of RULES) {
  await check(`no ${rule.name}`, () => {
    const offenders = [];
    for (const [file, source] of sources) {
      if (GUARD_FILES.has(file)) continue;
      if (rule.allowDocs && file.endsWith(".md")) continue;
      if (rule.skipLockFiles && file.endsWith(".lock")) continue;
      if (rule.pattern.test(source)) offenders.push(file);
    }
    if (offenders.length) throw new Error(offenders.join(", "));
  });
}

await check("no sandbox-weakening launch argument", () => {
  const offenders = [];
  for (const [file, source] of sources) {
    if (!/--no-sandbox|--disable-setuid-sandbox|--disable-web-security/.test(source)) continue;
    if (!SANDBOX_ALLOWED.has(file) && !file.endsWith("README.md")) offenders.push(file);
  }
  if (offenders.length) throw new Error(offenders.join(", "));
});

await check("only reserved or loopback hosts appear", () => {
  const offenders = [];
  for (const [file, source] of sources) {
    if (file.endsWith(".lock")) continue; // crate registry URLs
    if (GUARD_FILES.has(file)) continue;
    const hosts = remoteHosts(source);
    if (hosts.length) offenders.push(`${file}: ${[...new Set(hosts)].join(",")}`);
  }
  if (offenders.length) throw new Error(offenders.join("; "));
});

await check("page.setContent stays a single compatibility contract", () => {
  const offenders = [];
  for (const [file, source] of sources) {
    if (GUARD_FILES.has(file)) continue;
    if (source.includes("setContent(") && !file.startsWith("browser-contracts/")) offenders.push(file);
  }
  if (offenders.length) throw new Error(offenders.join(", "));
});

await check("the Rust fixture carries its lockfile and no compiled output", () => {
  const names = new Set(h3Files.map((file) => file.slice(3)));
  for (const required of ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/cert.rs"]) {
    if (!names.has(required)) throw new Error(`missing ${required}`);
  }
  const binaries = [...names].filter((name) => name.startsWith("target/"));
  if (binaries.length) throw new Error(`compiled output present: ${binaries.slice(0, 3).join(", ")}`);
});

await check("sources are real files with content", async () => {
  for (const file of sources.keys()) {
    const target = file.startsWith("h3:")
      ? path.join(H3_ROOT, file.slice(3))
      : path.join(AUDIT_ROOT, file);
    if ((await stat(target)).size === 0) throw new Error(`${file} is empty`);
  }
});

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(
  `\nsource guard: ${results.length - failed.length}/${results.length} passed over ${allFiles.length} files\n`
);
if (failed.length) process.exitCode = 1;
