# Cloakium audit contract

Status: **stable public contract, version 1**. The Rust crate is
`tools/browser-audit` (binary `cloakium-audit`). The schemas and fixtures in
this directory are the source of truth; the binary embeds the same files, so
`schema` output can never drift from the published contract.

Artifacts:

| Path | Purpose |
| --- | --- |
| `tests/audit/schema/SCHEMA.md` | this contract |
| `tests/audit/schema/plan.schema.json` | `cloakium.audit.plan/1` |
| `tests/audit/schema/report.schema.json` | `cloakium.audit.report/1` |
| `tests/audit/schema/runner.schema.json` | `cloakium.audit.runner/1` |
| `tests/audit/schema/policy.schema.json` | `cloakium.audit.policy/1` |
| `tests/audit/schema/inventory.schema.json` | `cloakium.audit.inventory/1` |
| `tests/audit/schema/compare.schema.json` | `cloakium.audit.compare/1` |
| `tests/audit/schema/catalog.schema.json` | `cloakium.audit.catalog/1` |
| `tests/audit/schema/execution.schema.json` | `cloakium.audit.execution/1` |
| `tests/audit/schema/fixtures/` | valid examples |

All documents are strict: unknown fields are rejected by the Rust serde types
and by the JSON Schema (`additionalProperties: false`, except the explicitly
open `contextOptions`, `suiteOptions`, `probeConfig`, observation values,
`diagnostics` and `environmentReceipt` objects). Optional fields are omitted, not `null`, unless the type
is explicitly nullable (`Check.passed`).

## CLI surface

```text
cloakium-audit inventory --plan PLAN | --artifact PATH [--launcher PATH]
cloakium-audit plan --baseline PATH --candidate PATH --client-module PATH --output FILE
cloakium-audit validate --plan FILE | --report FILE
cloakium-audit run --plan FILE --node PATH --runner PATH --output DIR
cloakium-audit finalize --run-dir EXISTING_DIR --output NEW_REPORT
cloakium-audit compare --baseline REPORT --candidate REPORT --output FILE
cloakium-audit catalog --input FILE [--input FILE ...] --output FILE
cloakium-audit schema [--name plan|report|runner|policy|compare|catalog|inventory|execution]
```

`inventory` prints the inventory bundle to stdout unless `--output` is given.
`plan`, `run`, `finalize`, `compare` and `catalog` write private evidence. `validate`
prints a validation document and exits non-zero only when the document is
invalid (valid-but-incomplete exits zero). `run` exits `0` when the report is
complete, `2` when a report was written but is incomplete, and `1` on a
preflight failure.

### Runner invocation (exact)

Rust invokes the selected Node runner once for the whole plan:

```text
<node> <runner.mjs> --plan <run-output>/plan.json --output <run-output>
```

There is **no `--out` flag**. The direct Node CLI has the same shape:

```text
node tests/audit/run.mjs --plan ABS_PLAN_JSON --output ABS_PRIVATE_DIR
```

Rust writes these files before invoking Node:

| File | Content |
| --- | --- |
| `<output>/plan.json` | byte-exact copy of the validated plan (its SHA-256 is `planHash`) |
| `<output>/environment.json` | `ResolvedEnvironment` with actual host/file provenance |
| `<output>/inventory.json` | immutable inventory, mode `0400` |
| `<output>/execution.json` | `cloakium.audit.execution/1` public job context and selected suite hash |
| `<output>/home`, `tmp`, `cache`, `config`, `runtime` | private child state, mode `0700` |

The runner must write the whole-plan protocol fragment to
`<output>/runner-report.json` (preferred) or `<output>/report.json` or
`<output>/runner.json`. Rust reads the first existing one, freezes a copy at
`runner-report.json`, and then writes the final `<output>/report.json`. A stdout
fallback is accepted only when no file exists and stdout is one complete JSON
object; otherwise stdout is treated as progress and rejected. Stdout must never
contain raw target text, credentials, BrowserServer WebSocket URLs or keys.

## `cloakium.audit.plan/1`

```json
{
  "schema": "cloakium.audit.plan/1",
  "id": "plan-1760000000000-1234",
  "environment": {
    "id": "local",
    "locale": "en-US",
    "timezoneId": "UTC",
    "fontconfigFile": "/private/fonts/fonts.conf",
    "fontconfigPath": "/private/fonts",
    "fontManifestSha256": "<64 lowercase hex>",
    "display": {
      "kind": "managed",
      "width": 1280,
      "height": 800,
      "depth": 24,
      "dpi": 96,
      "windowManager": "none",
      "ownershipManifestPath": "/private/display/ownership.json"
    },
    "notes": "optional"
  },
  "targets": [{
    "id": "baseline",
    "label": "Baseline",
    "artifactPath": "/absolute/original.elf",
    "executablePath": "/absolute/launcher.sh",
    "clientModule": "/absolute/client/index.js",
    "layer": "engine",
    "identity": "native",
    "args": [],
    "headlessArgs": [],
    "headedArgs": []
  }],
  "configurations": [{
    "id": "baseline-headless-1",
    "targetId": "baseline",
    "mode": "headless",
    "iteration": 1,
    "profileId": "default",
    "seed": "42424",
    "args": [],
    "contextOptions": {},
    "suites": ["fingerprint", "network"],
    "probeIds": ["navigator-core"],
    "scenarioIds": ["network-direct-http"],
    "suiteOptions": {"network": {"fixtureHost": "127.0.0.1"}},
    "probeConfig": {"optional": "arbitrary probe JSON"}
  }]
}
```

Field rules:

- `artifactPath` is the original engine/artifact; `executablePath` is the
  trusted launcher or the same path when there is no separate launcher. Both
  are recorded and hashed independently. They are never assumed equal.
- `layer` is `engine`, `launcher` or `product`; `identity` is `native` or
  `persona`. A comparison across layers or identities is reported as a
  confounder, never as an unqualified causal claim.
- `environment.locale` is the **browser** locale as BCP 47 (default `en-US`),
  never a POSIX locale such as `C.UTF-8`. Rust sets the child process
  `LANG`/`LC_ALL` to the valid fixed `C.UTF-8` and records those applied values
  as `resolved.locale.processLang`/`processLcAll`; the runner applies the browser
  locale through `contextOptions.locale` (or the environment field). A
  configuration-level `contextOptions.locale` must equal the environment locale.
- `clientModule` is the exact entry file the runner must load. Rust hashes this
  entry (`client.entrySha256` in reports) and accepts a runner `client.path`
  that is either this entry or its package root.
- `configurations` is flat. `profileId` labels a target-specific profile (for
  example `native`, `enabled`, `noise-off`); target-specific arguments belong in
  `configuration.args`. `seed` is a string or non-negative integer.
- `suites` names are `fingerprint`, `network`, `request-paths`,
  `wire-identity`, `browser-contracts`, `extended-network`,
  `profile-lifecycle`, `additional`. The generic runner expands every scenario
  in each named suite within the one configuration: `network` has 17,
  `request-paths` 5, `extended-network` 7. `scenarioIds` optionally selects an
  exact subset without expanding the plan matrix. `probeIds` optionally selects
  probes. Omit `scenarioIds` to run all suite scenarios; omit `probeIds` to run
  the suite's full probe set. An empty array is an explicit empty selection and
  cannot produce a complete report.
- `profile-lifecycle` runs its nine profile ids as separate persistent
  contexts, one at a time, with the strict base environment. They are not
  parallel contexts.
- `suiteOptions` and `probeConfig` are arbitrary JSON for fixture ports and
  probe settings. They must never contain credentials, tokens, cookies, license
  keys or arbitrary environment values.
- A complete plan needs both `headless` and `headed` configurations for every
  target, at least two contiguous iterations per mode starting at 1, at least
  one suite per configuration, and a usable display declaration. The generator
  defaults to both modes, two iterations and the `fingerprint` suite.

### Display and headed arguments

- `managed`: the selected runner/display helper creates and owns the virtual
  display. Rust does not create a display, does not set `DISPLAY`, and does not
  require an ownership manifest for this kind.
- `external-owned`: `ownershipManifestPath` is required and its basename must be
  `display.json`. The caller owns the display; `xauthorityPath` is recorded by
  metadata only (its contents are never read).
- `headedArgs` may contain the canonical literals `{display.display}`,
  `{display.xauthorityPath}` and `{display.stateDir}`. The runner resolves them
  **only for headed** children, after validating the helper/ownership manifest.
  A headless child must receive neither placeholder nor `DISPLAY`/`XAUTHORITY`
  from any ambient source.
- Rust never launches a display helper and never forwards an ambient `DISPLAY`,
  `XAUTHORITY`, D-Bus address or user session. `CLOAKIUM_AUDIT_DISPLAY_BIN` is
  the allowlisted helper path for the runner.

### Execution context

Rust writes `<output>/execution.json` (`cloakium.audit.execution/1`) before
launching Node:

```json
{
  "schema": "cloakium.audit.execution/1",
  "runId": "run-...",
  "planId": "plan-...",
  "planHash": "<64 hex>",
  "suiteManifestSha256": "<64 hex>",
  "nodeSha256": "<64 hex>",
  "runnerSha256": "<64 hex>",
  "timeoutMs": 3600000
}
```

It is the canonical way for the runner to know the selected manifest digest.
The same safe fixed digest is also available as
`CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256` (64 lowercase hex). Without
`--suite-manifest`, that digest is the selected runner file's SHA-256, so the
default controlled matrix needs no custom manifest and the runner can echo it.

## `cloakium.audit.runner/1` (whole plan)

The runner writes one document for the whole plan:

```json
{
  "schema": "cloakium.audit.runner/1",
  "planId": "plan-...",
  "planHash": "<64 lowercase hex>",
  "suite": {
    "manifestSha256": "<64 lowercase hex>",
    "probes": [{"id": "navigator.webdriver", "sha256": "<64 lowercase hex>"}]
  },
  "environment": { "...": "ResolvedEnvironment, echo of environment.json" },
  "runs": [{
    "configuration": { "...": "must equal the plan configuration exactly" },
    "version": "browser version string",
    "client": {
      "version": "client version",
      "path": "/absolute/package-or-entry",
      "sha256": "<whole package content manifest, or entry digest>",
      "packageSha256": "<optional>",
      "patchManifestSha256": "<optional>",
      "entrySha256": "<optional; Rust verifies against plan clientModule>"
    },
    "environment": { "...": "ResolvedEnvironment" },
    "observations": [{
      "id": "navigator.webdriver",
      "family": "navigator",
      "status": "observed",
      "result": {
        "observations": {"webdriver": false},
        "checks": [{"name": "webdriver-hidden", "passed": true, "status": "pass"}],
        "limitations": []
      }
    }],
    "cleanup": {
      "status": "clean",
      "notes": [],
      "browserClosed": true,
      "contextsClosed": true,
      "processExited": true
    },
    "durationMs": 1000,
    "limitations": []
  }],
  "errors": []
}
```

- `planId`/`planHash` are optional echoes but are verified when present.
- `environment` is optional at the top level; each run's environment is
  required. Rust merges the top-level environment into run provenance and
  preserves runner `diagnostics`.
- `suite.manifestSha256` must equal the selected suite manifest (or the runner
  file digest when `--suite-manifest` was not supplied). `suite.probes` is the
  hash registry for the selected suites. A report without probe hashes is
  incomplete.
- `client.sha256` is the whole client package content manifest when the parent
  lib supplies one; `packageSha256` and `patchManifestSha256` carry the explicit
  package facts. Rust always adds `entrySha256` for the plan client entry and
  rejects a conflicting runner value.
- Every plan configuration must appear exactly once. Missing runs are protocol
  errors and incomplete coverage; unknown or duplicate configurations are
  rejected.
- Transport is `playwright-websocket-over-browser-pipe` for both engines in a
  comparison. The runner uses `chromium.launchServer({host:'127.0.0.1', port:0,
  ...})` and `chromium.connect` through the public BrowserServer handle,
  retains the public `process()` handle, and calls `close()`/`kill()` for
  actual owned-PID cleanup. It must not read private Playwright internals
  (`_props` or similar). The WebSocket URL is secret-equivalent and is never
  logged or reported. Context probes are serial; persistent profiles use a
  separate controlled driver handler.

## `cloakium.audit.report/1`

The report is the Rust-owned final document:

```json
{
  "schema": "cloakium.audit.report/1",
  "runId": "run-...",
  "planId": "plan-...",
  "planHash": "<64 lowercase hex>",
  "suite": {
    "manifestSha256": "<64 lowercase hex>",
    "probes": [{"id": "navigator.webdriver", "sha256": "<64 lowercase hex>"}],
    "runner": {"path": "/absolute/runner.mjs", "sha256": "<64 lowercase hex>"},
    "node": {"path": "/absolute/node", "sha256": "<64 lowercase hex>", "version": "v26.0.0"}
  },
  "environment": { "...": "ResolvedEnvironment with actual provenance" },
  "targets": [{ "...": "InventoryRecord" }],
  "runs": [{ "...": "same RunRecord shape as the runner fragment" }],
  "errors": [{
    "kind": "protocol",
    "phase": "runner",
    "configurationId": "optional",
    "code": "optional-known-class",
    "operation": "optional",
    "targetClosed": true,
    "timeoutCategory": "optional",
    "message": "short sanitized summary only"
  }],
  "started": "2026-01-01T00:00:00.000Z",
  "finished": "2026-01-01T00:00:10.000Z",
  "complete": false,
  "completeness": ["reason"],
  "limitations": []
}
```

`complete` is the **acceptance** verdict, not merely "the matrix ran". It is
true only when:

- the plan is valid and complete;
- every planned configuration has exactly one accepted run;
- every observation is `observed`, has at least one functional check, and every
  check is `pass`;
- every cleanup is `clean` with no open resource claimed;
- the Rust process-cleanup receipt has no residual owned pid;
- the suite has probe hashes and the manifest hash is confirmed;
- inventory, node, runner and client entry digests are unchanged;
- there are no errors, unknown/unsupported rows, coverage gaps or timeouts.

A valid report may therefore be `complete: false` because an observed product
check failed or is unknown. That is not an execution error: the runner exits
`0` when the whole matrix executed, cleanup was proven and the protocol
fragment is valid, even when checks are `fail`/`unknown`. `compare` still
catalogues those valid incomplete reports. `ExecutionError` is reserved for
timeouts, crashes, protocol failures, cleanup failures and probe execution
errors, never for an intended capability gap.

`planHash` is the SHA-256 of the plan file bytes, not a re-serialization.
`processCleanup` is the Rust-owned receipt for the Node root process and every
owned descendant discovered through `/proc/<pid>/stat` (pid plus start ticks):
`discovered`, `signalled`, `residual`, `clean`. It never contains cmdline,
environ, executable names or private adapter details. Detached browser children
survive the Node process group in a new session, so Rust samples while the
runner is live, keeps identities through reparenting, and signals only the same
pid+starttime instance after the grace period.

### Environment provenance

`ResolvedEnvironment` repeats the declared environment and adds `resolved`:

```json
{
  "id": "private-linux",
  "locale": "en-US",
  "timezoneId": "UTC",
  "display": {"kind": "managed", "width": 1280, "height": 800, "depth": 24, "dpi": 96, "windowManager": "none"},
  "resolved": {
    "os": {"id": "nixos", "name": "NixOS", "versionId": "25.11", "prettyName": "...", "buildId": "unknown", "kernel": "6.12.0", "arch": "x86_64"},
    "timezone": {"id": "UTC", "zoneinfoPath": "/usr/share/zoneinfo/UTC", "exists": true},
    "fontconfig": {"declaredFile": "/private/fonts/fonts.conf", "realPath": "/private/fonts/fonts.conf", "exists": true, "sha256": "<64 hex>", "declaredPath": "/private/fonts", "pathRealPath": "/private/fonts", "pathExists": true},
    "display": {"kind": "managed", "displayName": ":99", "socketPath": "/tmp/.X11-unix/X99", "socketExists": true, "ownershipManifestPath": "/private/display/ownership.json", "ownershipManifestExists": true, "ownershipManifestSha256": "<64 hex>"},
    "locale": {"declared": "en-US", "source": "plan", "processLang": "C.UTF-8", "processLcAll": "C.UTF-8"},
    "environment": {"mode": "cleared+allowlist", "inherited": false, "appliedKeys": ["HOME", "LANG"], "displayKeys": [], "headlessDisplay": "not-set"}
  },
  "diagnostics": {"optional": "runner-supplied file hashes and environment diagnostics"},
  "environmentReceipt": {
    "id": "optional parent receipt",
    "platform": "linux",
    "architecture": "x86_64",
    "kernel": "6.12.0",
    "node": "v26.0.0",
    "locale": "en-US",
    "timezoneId": "UTC",
    "fontconfigFile": "/private/fonts/fonts.conf",
    "fontconfigSha256": "<64 hex>",
    "fontManifestSha256": "<actual font set digest>",
    "declaredFontManifestSha256": "<plan digest>",
    "fonts": {"files": [], "sha256": "<64 hex>", "tool": "/absolute/fc-list"},
    "envKeys": ["HOME", "LANG"],
    "ambientEndpointsExcluded": true,
    "display": {"kind": "managed"},
    "configSha256": "<64 hex>",
    "isolation": {"home": "private", "tmp": "private"}
  }
}
```

`resolved` is actual provenance read by Rust (`/etc/os-release`,
`/proc/sys/kernel/osrelease`, `stat`, real paths, fontconfig digest, display
socket existence, timezone file existence). The parent runner may add hashes
and diagnostics under `diagnostics` and the parent's richer `environmentReceipt`
map (actual `fc-list` font files, font-set digest, noexcept ambient endpoints,
isolation flags, config digest, optional `additionalArtifacts` hashes for an
explicitly selected public launcher/wrapper chain from
`probeConfig.provenanceFiles`). Both are open maps; no secret values are
allowed. The parent must not invent OS, locale, timezone, font or display
facts. No arbitrary environment values are recorded:
`appliedKeys` and `displayKeys` are names only. An Xauthority file is never
opened; only its path, real path, existence and mode are recorded.

## Tri-state observation contract

`Check.passed` is `true | false | null`; `Check.status` is optional and one of
`pass`, `fail`, `unknown`, `error`, `unsupported`, `skipped`,
`not-applicable`.

| `status` | `passed` | Effective result |
| --- | --- | --- |
| `pass` | `true` | pass |
| `fail` | `false` | fail |
| `unknown` | `false` or `null` | **unknown, not fail** |
| `error` | any non-true | execution error, separate from an observed inconsistency |
| `unsupported` | any non-true | unsupported, never a pass |
| `skipped` / `not-applicable` | any non-true | unknown/skipped, never a pass |
| omitted | `true` | pass |
| omitted | `false` | fail |
| omitted | `null` | unknown |

`pass` with anything other than `passed: true`, and `fail` with anything other
than `passed: false`, is invalid. An observation with no checks is unknown and
cannot satisfy completeness. An observation status of `unsupported` is
explicitly not absence and never a pass.

Canonical adapter mapping: `unavailable`, `stage-needed` and `inconclusive`
become `unknown`; `unsupported-by-target` becomes `unsupported`;
`observed-inconsistency` and `observed-with-limitations` become
`observed`; `execution-error` becomes `error`; `not-run` becomes `skipped`.
Observation ids, families and check names may contain `/` and spaces (for
example `storage/cookie-coherence` and `document replacement writes its DOM`);
they still reject empty values, control characters and overlength labels. Target
and configuration ids remain filesystem-safe ASCII.
The detailed original checks and coverage are retained under
`result.observations.$audit` rather than dropped, because the canonical check
has no free-form detail field. Limitation objects are flattened to strings while
the original nested objects remain under `$audit`. Feature/check ids are unique
`<suite>.<scenario>.<probe>` values across network, extended-network and
request-path multi-scenario rows, and the probe hash registry uses the same ids.

Runner exit status is `0` when the whole matrix executed, cleanup was proven
and the protocol fragment is valid, even if checks are `fail` or `unknown`.
Non-zero is reserved for execution/protocol failure, not an observed product
inconsistency. If the fragment fails fixed validation, the report error is a
short count plus stable validation codes (for example
`invalid runner-report.json: 12 validation error(s) [check.name]`), never the
concatenated untrusted finding text or raw ids. Detailed codes are kept in the
private `runner-report.validation.json`; the original fragment is already
private. The report must remain valid and incomplete, not fail internally.

## Runtime environment allowlist

Rust starts the runner with an empty environment and sets only:

| Key | Value/source |
| --- | --- |
| `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` | private directories under the run output |
| `PATH` | fixed `/run/current-system/sw/bin:/usr/bin:/bin` |
| `LANG`, `LC_ALL` | fixed `C.UTF-8`; the browser locale is the plan `locale` and travels in `contextOptions` |
| `CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256` | fixed 64-hex suite manifest digest for the selected runner |
| `TZ` | plan `timezoneId` |
| `FONTCONFIG_FILE` | plan `fontconfigFile`, when declared |
| `CLOAKIUM_H3_BIN` | caller env, only when it is an absolute executable file (public fixture binary) |
| `CLOAKIUM_AUDIT_DISPLAY_BIN` | caller env, only when it is an absolute executable helper |
| `CLOAKIUM_FC_LIST_BIN` | caller env, only when it is an absolute executable font-listing tool |
| `OPENSSL_BIN` | caller env, only when it is an absolute executable helper |
| `CLOAKIUM_AUDIT_SEAT_RUST` | always `1` under a Rust run |

Rust never sets `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `DYLD_*`
or debug variables, and never inherits a user session. Only the four explicit
public tool paths above are copied from the caller environment; each is
validated as an absolute executable file. They are public tool locations, never
license keys, tokens or other secrets.

No arbitrary environment is inherited. Credentials, license keys, proxy
passwords and tokens are not accepted in the plan, runner config, argv, logs or
report. A trusted private launch adapter owns its runtime license-key path; the
Node runner never handles that key. The runner may spawn children with its own
strict environment, but it must not expose `DISPLAY` to headless children.

## Exclusive seat

Rust holds an exclusive `flock` on
`$XDG_RUNTIME_DIR/cloakium-audit/seat.lock` (falling back to
`$XDG_STATE_HOME/cloakium-audit/seat.lock`) for the whole native-frontend run.
The kernel releases it on death; no stale PID is assumed. A second Rust run
fails before launching Node.

The Node side has a **separate, always-acquired** lease at
`/tmp/opencode/cloakium-audit-seat-${uid}`: atomic `mkdir`, `owner.json` with
pid plus process start ticks, directory `0700` and owner file `0600`, never
automatically stealing a lease. The Node lease is taken even when
`CLOAKIUM_AUDIT_SEAT_RUST=1` is present; that marker only tells Node not to take
a second **flock**. This common Node lease serializes a direct Node CLI run
against a Rust-launched Node run, while the Rust flock still excludes native
frontends. Explicit stale recovery must prove the original pid instance is
absent and require a cleanup receipt before reuse. No caller environment value
can bypass either seat.

## `cloakium.audit.policy/1`

```json
{
  "schema": "cloakium.audit.policy/1",
  "allowlist": [{
    "id": "persona-locale",
    "justification": "The persona profile intentionally uses fr-FR; this is a recorded policy, not a browser defect.",
    "featureIds": ["navigator.language"],
    "checks": ["language"],
    "modes": ["headless", "headed"]
  }],
  "stableFields": ["webdriver"]
}
```

Allowlist entries are exact: no `*`, no `all`, no empty feature list, and a
specific justification is required. `stableFields` are exact dotted paths into
`result.observations` with optional `[index]` selectors. Stable fields are the
only values compared as stable; every other unequal value is retained as
ordinary variation, never an automatic gap. A stable path that was never
observed makes the comparison incomplete.

## `cloakium.audit.compare/1`

Comparison classes:

| Class | Gap? | Meaning |
| --- | --- | --- |
| `capability-difference` | yes | executed functional check differs from the reference (fail vs reference pass, or pass vs reference fail) |
| `shared-failure` | yes | both sides fail the same executed check |
| `stable-field-difference` | yes | an explicitly declared stable value changed |
| `ordinary-variation` | no | an unequal value the policy did not declare stable; raw values retained |
| `headless-regression` | yes | within one target, headed passed while headless failed |
| `headless-improvement` | no | within one target, headless passed with actual acceptance while headed failed; headful-only evidence is never enough |
| `iteration-instability` | yes | the same target/mode/check or stable field changed across iterations |
| `execution-error` | yes | timeout, crash, cleanup failure or check/probe execution error; separate from observed inconsistency |
| `coverage-gap` | yes | missing run, observation, check, mode or scenario |
| `unsupported` | no | explicitly unsupported, never a pass or absence |
| `unknown` | no | unknown/skipped evidence; unknown is never a failure |
| `intentional-difference` | no | matched an exact recorded policy entry; original classification is retained |

Confounders are recorded separately (`browser-version`, `client`, `font`,
`display`, `os`, `locale`, `timezone`, `seed`, `identity`, `layer`,
`config-args`). `causalAttribution` is `unconfounded`, `version-confounded`,
`environment-confounded`, `profile-policy-confounded` or `mixed-confounded`.
A browser-version difference can still support an observed capability
difference, but never an unqualified vendor-patch causal claim.

`features` reports actual headless and headed coverage per feature. `complete`
requires the supplied plan to be valid and complete, both reports to be
complete, all plan configurations present, both modes accepted on both sides,
no gap/unknown/unsupported rows, and no unobserved stable field. A comparison
without `--plan` is retained but reports `complete: false`.

## `cloakium.audit.catalog/1`

The catalogue groups rows by `featureId`. It unions classifications, statuses,
checks, modes, confounders, policy ids, details and provenance; it preserves
`unknownProvenance` separately and never drops an unknown because another source
reported a failure. Source files are recorded by path, SHA-256 and schema.
Duplicate feature ids produce one canonical row.

## Inventory and security

`inventory` always requires `artifactPath` to be a native Linux ELF. The
`executablePath` may be either that ELF or a trusted **executable shebang
script** (the current Nix bash make-wrapper). A script launcher is classified by
its `#!` prefix and execute bit before hashing; its body, interpreter path and
private adapter details are never read into evidence or logged. The record
stores `kind: "script"` or `kind: "elf"` plus `elf` metadata only for ELF. A
script artifact, a non-executable `0600` file in either role, a foreign ELF and
a non-ELF/non-shebang file are refused before hashing. It records:

- `kind`, original path, canonical real path, symlink flag;
- SHA-256 before and after inspection, `unchanged`, size, mode, mode bits,
  uid/gid, executable bit;
- filesystem sandbox facts (`setuid`, `setgid`, `worldWritable`,
  `runtimeExercised: false`); runtime sandbox is not exercised by inventory;
- for ELF: class, endianness, OS ABI, type, machine, entry, program/section
  header counts and interpreter.

Inventory never executes the target and never asks it for a version. A version
is read only by an explicit `run`. Artifact and executable are separate records
and both digests/real paths are retained.

Unsupported targets are reported explicitly as unsupported; the tool never
claims that a capability is absent because a target is a script, a foreign ELF
or otherwise unsupported.

All output directories are `0700`; files are `0600` (immutable inventory and
incomplete reports are `0400`). Symlinks and non-regular overwrite targets are
rejected; overwriting a regular file requires `--force`, and run output must be
a fresh empty directory. Raw run output defaults outside the checkout under
`$XDG_STATE_HOME/cloakium-audit/runs/<runId>`.

Runner stdout/stderr logs are fresh `create_new` files (a pre-seeded symlink or
existing file is rejected), mode `0600`, capped at 16 MiB stdout and 1 MiB
stderr while reading; excess bytes are discarded rather than filling the disk.
Logs are private and are never copied into an error message or the report.

## Fixtures

- `fixtures/plan.json` — complete two-target, both-mode, two-iteration plan.
- `fixtures/report.json` — complete baseline report.
- `fixtures/report-candidate.json` — valid candidate report with failing checks.
- `fixtures/runner.json` — valid whole-plan runner fragment.
- `fixtures/inventory.json` — inventory bundle.
- `fixtures/inventory-script-launcher.json` — native ELF artifact with a script launcher.
- `fixtures/execution.json` — public execution context written before Node starts.
- `fixtures/policy.json` — exact allowlist and stable field.
- `fixtures/catalog.json` — canonical row preserving an unknown.

These fixtures contain synthetic paths and digests only. No fork-wide binary
digest, vendor version, provider name or key is hardcoded in the tooling.

## Finalize / recovery

`finalize --run-dir EXISTING --output NEW_REPORT` is a postprocessor for a
completed, already-closed run. It never invokes Node, a browser, a shell or a
resume path. It reads only `plan.json`, `inventory.json`, `execution.json`,
`runner-report.json` and the original `report.json`; source/artifact hashing is
limited to metadata verification and never executes the target.

It revalidates the fragment with the fixed rules, requires the plan/fragment/
execution identities and hashes to agree, requires the immutable `0400`
inventory snapshot to match the original report targets and still hash
unchanged, and accepts only
clean, closed cleanup receipts whose pid+start-ticks identities are terminal.
A live owned identity, a malformed plan, or an existing output path is refused.
A malformed fragment still yields a valid canonical incomplete report with
short sanitized errors; detailed validation findings are private and carry
stable codes, not raw labels. The original report is never modified. The new
report is written to a fresh path with mode `0600` and records:

```json
"postprocessingRecovery": {
  "originalReportPath": "/absolute/original/report.json",
  "originalReportSha256": "<64 hex>",
  "fragmentSha256": "<64 hex>",
  "planSha256": "<64 hex>",
  "toolVersion": "0.1.0",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "reason": "why recovery was required"
}
```

The recovered report preserves the original `runId`, `started`, `finished`,
suite runner/node identities, actual probe hash registry, environment,
inventory and canonical checks. It adds limitations explaining the
postprocessing version and any source change observed after the run. It does
not claim the source is unchanged or that the run was freshly executed.
