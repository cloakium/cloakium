import { fail, inconclusive, pass, result, stageNeeded } from "./kit.mjs";
import {
  createBudget,
  keyCandidates,
  localStateMetadata,
  privateRoot,
  readFixtureMarker,
  sameIdentifier,
  sanitizeError,
  scanDirectory,
  storeMetadata,
} from "./profile-export-io.mjs";

const DEFAULT_CANARY = "lab-canary-DO-NOT-USE";

const scanBudget = () => createBudget({ maxBytes: 192 * 1024 * 1024, maxMs: 20_000 });

const coverageNote = (coverage) =>
  `${coverage.filesScanned}/${coverage.fileCount} files, ${coverage.bytesRead} bytes, readErrors=${coverage.readErrors}, oversize=${coverage.oversize.length}, symlinks=${coverage.symlinkCount}, truncated=${coverage.truncated}, budget=${coverage.budgetExceeded}`;

const RAW_KEY_SCOPE =
  "metadata-only inspection cannot establish absence of raw key material: a key may be embedded in Local State or another store, encoded, or stored under a different name or length";

/**
 * Narrow, literal claim: the streamed canary is absent from every byte of the
 * covered tree. A leak fails regardless of the control; absence needs both full
 * coverage and proof that the canary was actually seeded.
 */
function canaryCheck(name, scan, { control, label }) {
  if (!scan.ok) return stageNeeded(name, scan.reason);
  if (scan.hits.length > 0) {
    return fail(name, `the dummy canary appeared in ${scan.hits.join(", ")}`);
  }
  if (control !== true) {
    return inconclusive(
      name,
      "positive control not established: the fixture did not confirm the canary cookie was seeded, so an absent canary proves nothing",
    );
  }
  if (!scan.coverage.complete) {
    return inconclusive(
      name,
      `the dummy canary was not found in the inspected subset (${coverageNote(scan.coverage)}); coverage is incomplete, so absence is not established`,
    );
  }
  return pass(name, `the dummy canary is absent from all ${scan.coverage.fileCount} ${label} files`);
}

/**
 * Narrow claim over a fully enumerated tree: no file whose *name* looks like a
 * key container was observed. Candidates are reported as inconclusive, never as
 * a defect, and never as proof of a secret.
 */
function candidateCheck(name, keys) {
  if (!keys.ok) return stageNeeded(name, keys.reason);
  if (keys.truncated) {
    return inconclusive(name, "the file listing was truncated, so candidate absence is not established");
  }
  if (keys.symlinkCount > 0) {
    return inconclusive(
      name,
      `${keys.symlinkCount} symlink(s) were skipped, so candidate absence is not established`,
    );
  }
  if (keys.candidates.length > 0) {
    const listed = keys.candidates.map((entry) => `${entry.path} (${entry.bytes}B, ${entry.sizeClass})`).join(", ");
    return inconclusive(
      name,
      `key-like named file(s) present: ${listed}; presence is not evidence that they hold key material`,
    );
  }
  return pass(name, "no file with a key-like name was observed in the enumerated tree");
}

async function inspectProfile(directory, { label, canary }) {
  const marker = await readFixtureMarker(directory);
  if (!marker.ok) return { ok: false, reason: marker.reason };
  const localState = await localStateMetadata(directory).catch((error) => ({
    ok: false,
    reason: `local state unreadable (${sanitizeError(error).code})`,
  }));
  const keys = await keyCandidates(directory).catch((error) => ({
    ok: false,
    reason: `key-name scan unreadable (${sanitizeError(error).code})`,
  }));
  const stores = await storeMetadata(directory).catch((error) => ({
    ok: false,
    reason: `store scan unreadable (${sanitizeError(error).code})`,
  }));
  const scan = await scanDirectory(directory, Buffer.from(String(canary), "utf8"), { budget: scanBudget() });
  return { ok: true, label, directory, marker: marker.metadata, localState, keys, stores, scan };
}

export const probes = [
  {
    id: "profile.export.security",
    family: "profile-export",
    stage: "static",
    requirements: {
      endpoints: [],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "caller-profile",
      relaunch: true,
      needs: "caller-supplied fresh fixture profile (profileDir), optional second profile (profileDirB), optional export bundle (exportDir) and optional post-copy profile (restartProfileDir); no browser required",
    },
    async run({
      profileDir = null,
      profileDirB = null,
      exportDir = null,
      restartProfileDir = null,
      labCanary = DEFAULT_CANARY,
      canaryControl = null,
      platform = process.platform,
    } = {}) {
      const seeded = canaryControl?.seeded === true;
      if (!profileDir) {
        return result({
          observations: { platform },
          checks: [stageNeeded("fixture-profile-supplied", "no profileDir supplied")],
          limitations: ["A caller-supplied fixture profile is required; this probe never inspects a real profile."],
        });
      }
      const primary = await inspectProfile(profileDir, { label: "primary", canary: labCanary });
      if (!primary.ok) {
        return result({
          observations: { platform, refusal: primary.reason },
          checks: [stageNeeded("fixture-profile-supplied", primary.reason)],
          limitations: [
            `The probe reads only a marker-verified fixture under ${privateRoot()}; it refuses anything else, including real user data.`,
          ],
        });
      }

      const checks = [];
      const untestedInputs = [];
      const observations = {
        platform,
        fixture: primary.marker,
        fileCount: primary.scan.ok ? primary.scan.coverage.fileCount : 0,
        scanCoverage: primary.scan.ok ? primary.scan.coverage : null,
        networkStores: primary.stores.ok ? primary.stores.stores.map((store) => store.path) : [],
        osCryptPresent: primary.localState.ok ? Boolean(primary.localState.osCryptPresent) : null,
        encryptedKeyScheme: primary.localState.ok ? primary.localState.scheme : null,
        encryptedKeyLength: primary.localState.ok ? primary.localState.keyLength : null,
        keyCandidates: primary.keys.ok ? primary.keys.candidates : null,
        canary: { provided: Boolean(labCanary), length: labCanary ? String(labCanary).length : 0, controlEstablished: seeded },
        rawKeyMaterialAbsence: "unknown",
        keyMaterialPolicy:
          "no key bytes are read; key-like files are reported by name, size and mode only, and their presence is not treated as a defect",
        inspectionPolicy: "artifact inspection only; no implementation code, disassembly or internal tables were consulted",
      };

      checks.push(canaryCheck("no-plaintext-canary-in-profile", primary.scan, { control: seeded, label: "profile" }));

      if (!primary.localState.ok) {
        checks.push(stageNeeded("local-state-parses", primary.localState.reason));
      } else if (!primary.localState.present) {
        checks.push(inconclusive("local-state-parses", "no Local State file in this fixture"));
      } else if (!primary.localState.parsable) {
        checks.push(fail("local-state-parses", "Local State is not valid JSON"));
      } else {
        checks.push(
          pass("local-state-parses", `os_crypt=${Boolean(primary.localState.osCryptPresent)}, keys=${primary.localState.keyNames.join(",") || "none"}`),
        );
      }

      const windowsBinding = platform === "win32";
      if (windowsBinding) {
        const present = primary.localState.ok && primary.localState.scheme !== null;
        checks.push(
          present
            ? pass("os-credential-binding", `os_crypt present, scheme=${primary.localState.scheme}`)
            : fail("os-credential-binding", "Windows fixture has no os_crypt.encrypted_key"),
        );
      } else {
        checks.push(
          inconclusive(
            "os-credential-binding",
            `not applicable on ${platform}: an OS-bound credential blob is a Windows artifact and cannot be validated here`,
          ),
        );
      }

      checks.push(candidateCheck("no-standalone-key-file-candidates-observed", primary.keys));

      // Broad claim: cannot be established from metadata, so it never passes.
      checks.push(inconclusive("no-raw-key-blob-in-profile", RAW_KEY_SCOPE));

      if (!primary.stores.ok) {
        checks.push(stageNeeded("cookie-store-is-sqlite", primary.stores.reason));
      } else if (primary.stores.stores.length === 0) {
        checks.push(inconclusive("cookie-store-is-sqlite", "no cookie or login store file found in the fixture"));
      } else {
        const allSqlite = primary.stores.stores.every((store) => store.sqliteHeader);
        checks.push(
          allSqlite
            ? pass("cookie-store-is-sqlite", `${primary.stores.stores.length} store file(s) have the SQLite header`)
            : fail("cookie-store-is-sqlite", JSON.stringify(primary.stores.stores.map((store) => ({ path: store.path, sqlite: store.sqliteHeader })))),
        );
      }

      let secondary = null;
      if (!profileDirB) {
        untestedInputs.push("profileDirB");
      } else {
        secondary = await inspectProfile(profileDirB, { label: "secondary", canary: labCanary });
        if (!secondary.ok) {
          checks.push(stageNeeded("per-profile-identifier-differs", secondary.reason));
        } else if (!windowsBinding) {
          checks.push(
            inconclusive(
              "per-profile-identifier-differs",
              `not applicable on ${platform}: OS-bound identifiers are absent by design and cannot be compared`,
            ),
          );
        } else {
          const same = sameIdentifier(primary.localState, secondary.localState);
          if (same === null) {
            checks.push(inconclusive("per-profile-identifier-differs", "at least one fixture has no os_crypt identifier"));
          } else if (same) {
            checks.push(
              fail("per-profile-identifier-differs", "both fixtures share one os_crypt blob, a global identifier rather than a per-profile one"),
            );
          } else {
            checks.push(pass("per-profile-identifier-differs", "each fixture has its own os_crypt identifier"));
          }
        }
      }

      let exportReport = null;
      if (!exportDir) {
        untestedInputs.push("exportDir");
      } else {
        exportReport = await inspectProfile(exportDir, { label: "export", canary: labCanary });
        if (!exportReport.ok) {
          checks.push(stageNeeded("export-bundle-inspected", exportReport.reason));
        } else {
          observations.exportCoverage = exportReport.scan.ok ? exportReport.scan.coverage : null;
          checks.push(
            canaryCheck("export-has-no-plaintext-canary", exportReport.scan, { control: seeded, label: "export" }),
          );
          checks.push(candidateCheck("export-has-no-standalone-key-file-candidates", exportReport.keys));
          checks.push(inconclusive("export-has-no-bundled-raw-key", RAW_KEY_SCOPE));
          if (!windowsBinding) {
            checks.push(
              inconclusive(
                "export-does-not-rely-on-host-credential-store",
                `not applicable on ${platform}: host-bound credential blobs are a Windows artifact`,
              ),
            );
          } else if (sameIdentifier(primary.localState, exportReport.localState) === true) {
            checks.push(
              inconclusive(
                "export-does-not-rely-on-host-credential-store",
                "export carries the host os_crypt blob verbatim; a portable export needs a caller-owned wrap",
              ),
            );
          } else {
            checks.push(
              pass("export-does-not-rely-on-host-credential-store", "no shared host os_crypt identifier in the export"),
            );
          }
        }
      }

      let restartReport = null;
      if (!restartProfileDir) {
        untestedInputs.push("restartProfileDir");
      } else {
        restartReport = await inspectProfile(restartProfileDir, { label: "restart", canary: labCanary });
        if (!restartReport.ok) {
          checks.push(stageNeeded("restart-copy-inspected", restartReport.reason));
        } else {
          observations.restartCoverage = restartReport.scan.ok ? restartReport.scan.coverage : null;
          checks.push(
            canaryCheck("restart-copy-has-no-plaintext-canary", restartReport.scan, { control: seeded, label: "restart-copy" }),
          );
          checks.push(candidateCheck("restart-copy-has-no-standalone-key-file-candidates", restartReport.keys));
          checks.push(inconclusive("restart-copy-has-no-raw-key", RAW_KEY_SCOPE));
          if (!windowsBinding) {
            checks.push(
              inconclusive(
                "restart-copy-not-host-bound",
                `not applicable on ${platform}: the copy cannot carry a Windows-bound blob`,
              ),
            );
          } else {
            const same = sameIdentifier(primary.localState, restartReport.localState);
            checks.push(
              same === null
                ? inconclusive("restart-copy-not-host-bound", "no os_crypt identifier to compare")
                : same
                  ? inconclusive(
                      "restart-copy-not-host-bound",
                      "the copy carries the source host-bound identifier verbatim; portability needs a caller-owned wrap",
                    )
                  : pass("restart-copy-not-host-bound", "the copy carries a different identifier than the source"),
            );
          }
        }
      }

      observations.untestedInputs = untestedInputs;
      observations.identifiers = {
        primary: primary.localState.ok ? primary.localState.scheme : null,
        secondary: secondary?.localState?.ok ? secondary.localState.scheme : null,
        export: exportReport?.localState?.ok ? exportReport.localState.scheme : null,
        restart: restartReport?.localState?.ok ? restartReport.localState.scheme : null,
        comparison: "digests are compared in memory; no key value or digest is reported",
      };

      return result({
        observations,
        checks,
        limitations: [
          "Canary absence is a narrow claim about the streamed bytes of the covered tree, and only passes with complete coverage and a confirmed seeded-cookie positive control.",
          "Key-like file names are a candidate heuristic: presence is reported as inconclusive, not as a defect, and absence of such names is not proof that no key material exists in any form.",
          "Raw key material may be embedded, encoded, or stored under another name or length; its absence is reported as unknown.",
          "OS-bound credential blobs are Windows-specific; on other platforms their absence is reported as inconclusive rather than as a pass or a defect.",
          "Encrypted payloads are never decrypted, key bytes are never read, and only metadata plus in-memory identifier comparison is used.",
          `The probe reads only marker-verified fixtures under ${privateRoot()} and refuses any other path, including real user data.`,
        ],
      });
    },
  },
];
