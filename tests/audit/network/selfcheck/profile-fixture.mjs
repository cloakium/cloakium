/** Validates profile.export.security against synthetic fixtures (no browser, no real data). */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateRoot } from "../lab/util.mjs";
import { probes } from "../index.mjs";

const probe = probes.find((entry) => entry.id === "profile.export.security");
const CANARY = "lab-canary-DO-NOT-USE";
const CONTROL = { seeded: true };
const SQLITE = Buffer.concat([Buffer.from("SQLite format 3\u0000", "utf8"), randomBytes(64)]);
const MARKER = { schema: "cloakium.profile-lifecycle-fixture/1", owner: "profile-lifecycle" };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}\n`);
}

function cryptFor(keyByte) {
  // Chrome stores base64("v10" || ciphertext); the probe reports only the scheme.
  return Buffer.concat([Buffer.from("v10"), Buffer.alloc(16, keyByte)]).toString("base64");
}

async function fixture(root, name, { canary = false, keyByte = 7, noCrypt = false, dirMode = 0o700, marker = null } = {}) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, "Default"), { recursive: true, mode: 0o700 });
  await chmod(dir, dirMode);
  await writeFile(
    path.join(dir, "LAB_FIXTURE.json"),
    JSON.stringify(marker ?? { ...MARKER, kind: "selfcheck", label: name, created: new Date().toISOString() }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dir, "Local State"),
    noCrypt ? JSON.stringify({ profile: name }) : JSON.stringify({ os_crypt: { encrypted_key: cryptFor(keyByte) } }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "Default", "Cookies"),
    canary ? Buffer.concat([SQLITE, Buffer.from(CANARY, "utf8")]) : SQLITE,
  );
  return dir;
}

function byName(output, name) {
  return output.checks.find((check) => check.name === name) ?? null;
}

const root = await mkdtemp(path.join(privateRoot(), "cloakium-profile-check-"));
try {
  const alpha = await fixture(root, "alpha", { keyByte: 3 });
  const beta = await fixture(root, "beta", { keyByte: 9 });
  const dirty = await fixture(root, "dirty", { canary: true });
  const linuxStyle = await fixture(root, "linux-style", { noCrypt: true });
  const cleanExport = path.join(root, "export-clean");
  const leakyExport = path.join(root, "export-leaky");
  for (const directory of [cleanExport, leakyExport]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, "LAB_FIXTURE.json"), JSON.stringify({ ...MARKER, kind: "selfcheck-export" }), { mode: 0o600 });
  }
  await writeFile(path.join(cleanExport, "Local State"), JSON.stringify({ profile: "alpha" }), "utf8");
  await writeFile(path.join(leakyExport, "key"), randomBytes(32));

  const win = await probe.run({ profileDir: alpha, profileDirB: beta, exportDir: cleanExport, canaryControl: CONTROL, platform: "win32" });
  // The probe is deliberately inconclusive overall: it carries bound claims
  // that can never pass from metadata alone.
  record(
    "fixture-profile-accepted",
    ["pass", "partial", "inconclusive"].includes(win.status),
    win.status,
  );
  record("no-plaintext-canary", byName(win, "no-plaintext-canary-in-profile")?.status === "pass");
  record("win-os-credential-binding", byName(win, "os-credential-binding")?.status === "pass");
  record("per-profile-identifier-differs", byName(win, "per-profile-identifier-differs")?.status === "pass");
  record(
    "narrow-candidate-absence-passes",
    byName(win, "no-standalone-key-file-candidates-observed")?.status === "pass",
  );
  record(
    "broad-profile-raw-key-claim-is-inconclusive",
    byName(win, "no-raw-key-blob-in-profile")?.status === "inconclusive" &&
      byName(win, "no-raw-key-blob-in-profile")?.passed === false,
    byName(win, "no-raw-key-blob-in-profile")?.detail,
  );
  record(
    "broad-export-raw-key-claim-is-inconclusive",
    byName(win, "export-has-no-bundled-raw-key")?.status === "inconclusive",
  );
  record("cookie-store-is-sqlite", byName(win, "cookie-store-is-sqlite")?.status === "pass");
  record(
    "no-key-bytes-in-observations",
    !JSON.stringify(win.observations).includes(cryptFor(3)),
    "only scheme marker and length are reported",
  );

  const bad = await probe.run({ profileDir: dirty, labCanary: CANARY, canaryControl: CONTROL, platform: "win32" });
  record("canary-detected-as-failure", byName(bad, "no-plaintext-canary-in-profile")?.status === "fail");

  const noControl = await probe.run({ profileDir: alpha, labCanary: CANARY, platform: "linux" });
  record(
    "canary-absence-requires-positive-control",
    byName(noControl, "no-plaintext-canary-in-profile")?.status === "inconclusive",
    byName(noControl, "no-plaintext-canary-in-profile")?.detail,
  );

  const leaky = await probe.run({ profileDir: alpha, exportDir: leakyExport, canaryControl: CONTROL, platform: "win32" });
  record(
    "candidate-presence-is-inconclusive-not-defect",
    byName(leaky, "export-has-no-standalone-key-file-candidates")?.status === "inconclusive" &&
      byName(leaky, "export-has-no-standalone-key-file-candidates")?.passed === false,
    byName(leaky, "export-has-no-standalone-key-file-candidates")?.detail,
  );

  const sameKey = await fixture(root, "alpha-copy", { keyByte: 3 });
  const shared = await probe.run({ profileDir: alpha, profileDirB: sameKey, canaryControl: CONTROL, platform: "win32" });
  record("shared-global-key-detected", byName(shared, "per-profile-identifier-differs")?.status === "fail");

  const linux = await probe.run({ profileDir: linuxStyle, profileDirB: beta, canaryControl: CONTROL, platform: "linux" });
  record(
    "linux-os-binding-is-inconclusive",
    byName(linux, "os-credential-binding")?.status === "inconclusive",
    byName(linux, "os-credential-binding")?.detail,
  );
  record(
    "linux-per-profile-is-inconclusive",
    byName(linux, "per-profile-identifier-differs")?.status === "inconclusive",
    byName(linux, "per-profile-identifier-differs")?.detail,
  );

  const restartSame = await fixture(root, "restart-same", { keyByte: 3 });
  const sameRestart = await probe.run({ profileDir: alpha, restartProfileDir: restartSame, canaryControl: CONTROL, platform: "win32" });
  record("verbatim-host-blob-flagged", byName(sameRestart, "restart-copy-not-host-bound")?.status === "inconclusive");

  const restartDifferent = await fixture(root, "restart-different", { keyByte: 11 });
  const differentRestart = await probe.run({ profileDir: alpha, restartProfileDir: restartDifferent, canaryControl: CONTROL, platform: "win32" });
  record("per-profile-restart-copy-ok", byName(differentRestart, "restart-copy-not-host-bound")?.status === "pass");

  const refused = await probe.run({ profileDir: path.join(path.parse(root).root, "not-a-lab-fixture") });
  record("outside-private-root-refused", refused.status === "stage-needed" && /outside/.test(refused.checks[0].detail ?? ""));

  const missing = await probe.run({ profileDir: path.join(root, "nope") });
  record("missing-marker-refused", missing.status === "stage-needed");

  const forged = await fixture(root, "forged", { marker: { fixture: true, name: "forged" } });
  record("forged-marker-refused", (await probe.run({ profileDir: forged })).status === "stage-needed");

  const looseMarker = await fixture(root, "loose-marker");
  await chmod(path.join(looseMarker, "LAB_FIXTURE.json"), 0o644);
  record("wrong-marker-mode-refused", (await probe.run({ profileDir: looseMarker })).status === "stage-needed");

  const looseDir = await fixture(root, "loose-dir", { dirMode: 0o755 });
  record("non-private-directory-refused", (await probe.run({ profileDir: looseDir })).status === "stage-needed");

  const symlinked = await fixture(root, "symlinked");
  await symlink(path.join(root, "alpha"), path.join(symlinked, "Default", "escape"));
  const symlinkRun = await probe.run({ profileDir: symlinked, canaryControl: CONTROL, platform: "linux" });
  record(
    "symlink-makes-coverage-incomplete",
    byName(symlinkRun, "no-plaintext-canary-in-profile")?.status === "inconclusive",
    byName(symlinkRun, "no-plaintext-canary-in-profile")?.detail,
  );

  const oversize = await fixture(root, "oversize");
  await writeFile(path.join(oversize, "huge.bin"), "");
  await truncate(path.join(oversize, "huge.bin"), 64 * 1024 * 1024 + 1);
  const oversizeRun = await probe.run({ profileDir: oversize, canaryControl: CONTROL, platform: "linux" });
  record(
    "oversize-makes-coverage-incomplete",
    byName(oversizeRun, "no-plaintext-canary-in-profile")?.status === "inconclusive",
  );

  assert.equal(results.filter((entry) => !entry.ok).length, 0, "profile probe selfcheck failures");
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`\nprofile selfcheck: ${results.length} checks\n`);
