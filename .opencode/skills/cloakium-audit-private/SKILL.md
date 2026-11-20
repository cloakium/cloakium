---
name: Cloakium private browser audit
description: Audit an explicitly named Chromium fork binary, launcher, artifact or repository in a private workflow. Use when the user supplies a binary or target and wants identity and layer separation, reused evidence, an ordered headless/headed matrix, network-path attribution, provenance hashes and an atomic private report. It never audits CAPTCHAs, protected third-party sites or detector scores, and never handles license keys.
license: MIT
---

Audit exactly the target the user names. Everything below produces private
evidence; none of it is a claim that a site will accept the browser.

## Hard boundaries

- A binary, launcher, archive or repository named by the user is the only target.
  A path found during discovery is a candidate, not an instruction. Never
  download, install or update a browser as part of an audit.
- Authorized local fixtures only. No CAPTCHA, no protected detector, no
  third-party score, no "does site X accept this browser" probe.
- Legal private use is not a redistribution right. Record the observed license
  and stop there; vendor marketing is not permission.
- Never bypass normal license validation, activation or concurrency checks. A
  key, when one is genuinely required, is read at runtime from a user-supplied
  file descriptor or a mode-0600 scoped file. It never appears in argv, a log, a
  report, a hashed input or a store path.
- Keep Chromium's sandbox enabled. Never set `CLOAKIUM_TEST_NO_SANDBOX=1`. A host
  that cannot create namespaces is a blocked run, not a pass.
- Private output lives outside the public checkout, directory mode 0700, files
  mode 0600. Raw vendor analysis is never copied into the repository.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `--binary PATH` | yes | Exact executable under audit; `realpath` output is the identity key |
| `--launcher PATH` | no | Wrapper or launcher, kept distinct from the engine |
| `--artifact PATH` | no | Installer/archive/package; hashed and identified, never executed |
| `--repo PATH` | no | Checkout used only for source and receipt evidence |
| `--out DIR` | yes | Private evidence root outside the repository |
| `--seed N` | no | One fixed fingerprint seed for the whole matrix |
| `--profile headless\|headed\|matrix` | no | Default `matrix`, meaning both modes |
| `--deadline SECONDS` | no | Wall-clock budget for the whole run |

## Step 0 — install and read the tool surface

The flake exposes `.#audit` and `.#audit-display`. Install both once; the audit
itself never downloads or installs a browser:

```sh
nix profile install .#audit .#audit-display
```

Then read the real interface, which is the authority for flags:

```sh
cloakium-audit --help
cloakium-audit run --help
```

The surface is `inventory`, `plan`, `validate`, `run`, `compare`, `catalog` and
`schema`. `inventory` and `plan` never execute the target; `run` executes one
validated plan through an explicit Node runner. The verified help snapshot and
per-command flags are in `references/cli-receipt.md`; `--help` on the build you
use remains the authority. The published document versions
are `cloakium.audit.plan/1`, `report/1`, `runner/1`, `execution/1`, `policy/1`,
`inventory/1`, `compare/1` and `catalog/1`; use
`cloakium-audit schema --name plan` to print one. Use only flags the help lists;
a missing flag is a contract change to report, not a reason to invent one.

## Step 1 — identity, one layer at a time

Record each layer separately, because a wrapper version, an engine version and a
driver version are different facts. Run these from this checkout's root; the
audit target itself remains external. The examples assume `BINARY` is the target
path the user named:

```sh
AUDIT_RUN=$(mktemp -d /tmp/cloakium-audit.XXXXXX)
chmod 700 "$AUDIT_RUN"
realpath "$BINARY"
sha256sum "$BINARY"
"$BINARY" --version
```

```sh
grep -n "CLOAKIUM_REAL_CHROMIUM" "$(realpath "$BINARY")"
```

The `grep` is evidence only: it shows whether the target is a launcher and what
engine it names. Do not execute the launcher again to rediscover that path, and
do not rebuild the engine to identify it; hash the named path directly when it
exists.

Driver/SDK layer, when the checkout has a patched `playwright-core`:

```sh
node -p "require('playwright-core/package.json').version"
node -p "require('playwright-core/package.json').cloakium"
sha256sum node_modules/playwright-core/CLOAKIUM-PATCHES.json
```

An absent `cloakium` marker means the driver layer is unpatched. Say so; do not
attribute browser behaviour to a driver patch that is not installed.
`tests/audit/lib/hashes.mjs` `loadDriver` records the module path, module SHA-256,
`package.json` SHA-256 and patch-manifest SHA-256, and requires an explicitly
selected Playwright client that exposes `chromium.launchServer` and
`chromium.connect`.

Artifact identity is format plus digest, never format alone:

```sh
sha256sum "$ARTIFACT"
nix hash file --sri "$ARTIFACT"
file "$ARTIFACT"
```

If `--artifact` is an archive, record its name, size, magic and digest. Never
extract it into the repository and never run its installer as part of the audit.

When the driver is installed, let it produce the identity bundle in one step:

```sh
cloakium-audit inventory --artifact "$BINARY" --launcher "$LAUNCHER" --client-module "$CLIENT" --id target --layer engine --identity native --output "$AUDIT_RUN/inventory/target.json"
```

`inventory` proves the artifact is a native Linux ELF and the launcher is either
an ELF or a trusted shebang script, records real paths, `FileIdentity.kind` with
an optional ELF detail, and SHA-256 before and after; it never executes either.
Omit `--launcher` when the target is the executable; omit `--client-module` when
no client is selected yet. See `references/evidence-and-layers.md` for the full
record shape and reuse rules.

## Step 2 — private evidence root

Create the output layout outside the checkout and reuse an existing checkpoint
instead of re-running a finished phase:

```sh
mkdir -p "$AUDIT_RUN/inventory" "$AUDIT_RUN/matrix" "$AUDIT_RUN/network" "$AUDIT_RUN/report"
```

A phase is reusable only when its recorded input digest, seed, probe-set version
and mode match the current run. A differing digest means a new checkpoint, not
an edit of the old one.

## Step 3 — display-stripped environment

Same seed, locale, timezone, client build and flags in both modes. Headless gets
no display connection at all; headed gets only an owned virtual display. Remove
the display and session variables explicitly rather than inheriting a desktop:

```sh
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE node tests/parity/run.mjs --binary "$BINARY" --output "$AUDIT_RUN/matrix/headless.json" --repeat 2
```

The parity runner owns its private Xvfb reference and deletes `WAYLAND_DISPLAY`
before starting children. Do not point any run at a personal desktop session and
do not export `DISPLAY` yourself. Keeping the devShell `PATH` is deliberate: the
same client and flags must run in both modes. A fully minimal environment is the
audit CLI's job once it exists.

If `.envrc` and `flake.nix` both exist, run `direnv reload` instead of
`nix develop`. This checkout has `flake.nix` and no `.envrc`, so the command
above is correct here. See `references/evidence-and-layers.md` for the exact
variables that must be absent per mode.

## Step 4 — ordered matrix

Run modes in a recorded order. The driver's plan is the canonical matrix:
baseline and candidate, both modes, two iterations per target by default, all
behind one plan digest. `BASELINE` and `CANDIDATE` are explicit artifact paths;
`CLIENT` is the Playwright module selected for both:

```sh
cloakium-audit plan --baseline "$BASELINE" --candidate "$CANDIDATE" --client-module "$CLIENT" --suite fingerprint --locale en-US --output "$AUDIT_RUN/plan.json"
cloakium-audit validate --plan "$AUDIT_RUN/plan.json"
export CLOAKIUM_AUDIT_DISPLAY_BIN="$(command -v cloakium-audit-display)"
cloakium-audit run --plan "$AUDIT_RUN/plan.json" --node "$(command -v node)" --runner tests/audit/run.mjs --output "$AUDIT_RUN/run" --timeout 3600
```

`run` clears the inherited environment, owns one process group, enforces one
wall-clock deadline and never launches a duplicate after a timeout. It exits 0
for a complete report, 2 for a written but incomplete report, and 1 for a
preflight failure. A valid but incomplete plan is still a result to report, not
a pass.

Add `--baseline-launcher` and `--candidate-launcher` when a wrapper is under
test. `--iterations` defaults to 2, and a complete plan needs both `headless` and
`headed` configurations for every target. Each target/profile/scenario needs
both modes with iterations contiguous from 1 and at least two per mode; one
iteration is valid but incomplete, as a smoke plan may be. `--suite` is
repeatable; `fingerprint` is the default suite.

`run` and a direct Node invocation share one seat lease at
`/tmp/opencode/cloakium-audit-seat-<uid>`; they cannot run concurrently. The
lease owner is a `pid:startTicks` pair, a live or unverified lease is never
stolen, and stale recovery is a manual call that requires the recorded owned
children to be verified gone.

For this checkout's own regression suite, the parity runner remains the verified
behavioural path. The runner alternates mode order across iterations, so
`--repeat 2` exposes order dependence instead of hiding it. The Step 3 headless
report is the first entry; the native-defaults profile and the fullscreen
reference complete it:

```sh
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE node tests/parity/run.mjs --binary "$BINARY" --native-defaults --output "$AUDIT_RUN/matrix/headless-native.json" --repeat 2
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE node tests/parity/fullscreen.mjs --binary "$BINARY" --output "$AUDIT_RUN/matrix/fullscreen.json"
```

`--native-defaults` separates native Chromium configuration from
automation-adapter defaults. Both profiles are mandatory; a single-profile pass
is not an audit result. The headed reference is a control, not a production
dependency: headless runs must never require a display, and headed runs use only
the owned virtual display. Driver and native smoke evidence, in the same stripped
environment:

```sh
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE CLOAKIUM_BINARY_PATH="$BINARY" node tests/driver/smoke.mjs
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE CLOAKIUM_BINARY_PATH="$BINARY" node tests/native/smoke.mjs
```

## Step 5 — network paths and UDP attribution

Five paths must be attributed separately, each with a positive control proving
the measurement can observe the path at all:

| Path | Required observation |
| --- | --- |
| Direct HTTP(S) over TCP | Request reaches the local fixture and the response arrives |
| Proxied HTTP(S) over TCP | Traffic reaches the fixture proxy, not the direct origin |
| DNS resolution | Query is observed at the local resolver, including DoH when configured |
| WebRTC/STUN over non-proxied UDP | Hardened mode fails closed; the stock control must produce a binding request |
| QUIC/HTTP3 over UDP 443 | Blocked or documented, never silently assumed |

```sh
nix develop . -c env -u DISPLAY -u WAYLAND_DISPLAY -u XAUTHORITY -u XDG_SESSION_TYPE CLOAKIUM_BINARY_PATH="$BINARY" node tests/browser/run.mjs --no-bun
```

The WebRTC suite runs a localhost-only STUN responder and asserts both the
baseline request and the hardened zero-request case. A path without a working
positive control is `inconclusive`, not a pass. Do not capture or print proxy
credentials; `docs/api.md` records why they never go on the Chromium command
line.

`tests/audit/network` adds DoH, HTTP/2, HTTP/3, SOCKS5 and transparent-proxy
labs, exercised through the versioned plan and runner:

```sh
node tests/audit/run.mjs --plan "$AUDIT_RUN/plan.json" --output "$AUDIT_RUN/run-direct"
```

A direct suite invocation without a plan is partial evidence, not a completed
audit. Node writes the whole-plan fragment to `<output>/runner-report.json`
(schema `cloakium.audit.runner/1`). Rust freezes that fragment and writes the
final `<output>/report.json` (schema `cloakium.audit.report/1`). Do not treat the
runner fragment as the audit report, and do not write `report.json` yourself.

Rust also writes `<output>/execution.json` (schema
`cloakium.audit.execution/1`) and exports
`CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256` as a fixed 64-hex digest for a custom
manifest; the Node runner reads that value. It is execution provenance, not a
substitute for the report.

The socket witness is passive: it attributes sampled Linux socket inodes to
owned `pid:startTicks` processes and records `absenceEstablished: false`. Its
`schema` is `cloakium.audit.socket-witness/1` with coverage
`sampled-owned-socket-metadata`. Absence of a sampled socket is never a
zero-egress proof, and it excludes every unowned user process.

## Step 6 — classify, never round up

Use the canonical report contract in `tests/audit/schema/SCHEMA.md`; do not
invent a parallel vocabulary. A `Check` keeps `passed: true | false | null`
plus an optional `status`, and an observation carries `observed`, `error`,
`unsupported` or `skipped`.

| Native probe result | `Check.status` | Effective meaning |
| --- | --- | --- |
| `pass` | `pass` | Ran and held |
| `fail` | `fail` | Ran and failed; a measured difference |
| `unavailable` | `unknown` | Host or capability prevented it; never a pass |
| `unsupported-by-target` | `unsupported` | Target lacks the capability by design |
| `stage-needed` | `skipped` or `unknown` | Prerequisite missing; never a pass |
| `inconclusive` | `unknown` | Not evaluable; a null capability is not a pass |
| exception | `error` | Execution error, kept separate from an observed inconsistency |

The adapter preserves the probe's original tri-state detail under
`result.observations.$audit.originalChecks` and `originalLimitations`, with
phases kept separate. Do not discard that detail when reporting a canonical
`unknown`.

For an intentional privacy boundary, record the policy check as `pass` and the
blocked path as `unsupported` or `unknown`. WebRTC non-proxied UDP, forced proxy
paths and proxy-key protection are expected fail-closed cases, not gaps.

## Step 6a — coverage is not all-pass

Rust `complete: true` requires a valid, complete plan, exactly one accepted run
per configuration, every observation `observed` with at least one functional
check, every check `pass`, clean cleanup, confirmed manifest and entry hashes,
and no error, unknown, unsupported, skipped, coverage-gap or timeout row.

A report can be valid and `complete: false`. An observed capability gap is the
expected result on a target without that capability, not an execution failure.
State both facts separately: what executed, and whether everything passed.

- The Node runner exits 0 when every selected probe executed and cleanup was
  clean, even when a check failed. An exception row is an execution error and
  exits 1.
- Rust `run` exits 0 for a complete report, 2 for a written but incomplete
  report, and 1 for a preflight failure.

Never report "all probes pass" when the evidence only establishes executed
coverage.

A runtime crash is not a feature difference. Preserve intentional Linux,
real-hardware, WebRTC and proxy-key fail-closed behaviour; do not "fix" it into a
pass. Unsupported or inconclusive must remain explicit in the report.

## Step 7 — atomic private report

The report helpers are already defined in `tests/audit/lib/secure-io.mjs`:

- `privateDirectory` requires an owned, non-symlink directory with mode 0700;
- `atomicJson` writes a mode-0600 temporary, fsyncs, then uses an exclusive
  hardlink for a fresh artifact so it cannot be overwritten or race, and a
  verified rename only for the current run's rolling report;
- `serializable` and `redactText` drop credentials and reject cycles;
- `safeError` keeps the category and omits raw target or driver text that may
  contain credentials.

Use those helpers for every report write; do not hand-roll a rename. Record the
finished file's digest for the receipt:

```sh
sha256sum "$AUDIT_RUN/report/report.json"
```

The report records, at minimum: schema version, target identities and digests,
seed, mode order, environment variable names present and the display variables
that were absent, probe-set versions, per-check result class, intentional
fail-closed notes, and the provenance digest set. Provenance covers the binary,
launcher, client module and package file, probe set, config and font set. Use
`sourceManifest` for the probe-set digest: it hashes only `mjs`, `json`, `rs` and
`toml` files, skips `node_modules`, `target`, `reports` and `evidence`, and
rejects symlinks. Hash a font set only when the environment exposes a font tool;
otherwise record `font-provenance: inconclusive`.

`references/private-outputs.md` gives the exact exclusive-create, hardlink and
rename rules, the PID plus start-ticks ownership model, and the minimal launch
environment. Follow it instead of describing a generic "atomic write".

## Step 8 — repeatability for the next fork version

The same command sequence must produce a comparable artifact for a future fork
version:

1. Reuse the same seed, modes, mode order and probe-set version.
2. Diff by catalog ID, not by file order.
3. Report added, removed and changed IDs separately from value changes.
4. Keep the previous checkpoint; write the new one beside it.

Compare reports and merge gaps with the driver, not by hand:

```sh
cloakium-audit compare --baseline "$BASELINE_REPORT" --candidate "$CANDIDATE_REPORT" --baseline-target baseline --candidate-target candidate --plan "$AUDIT_RUN/plan.json" --policy "$AUDIT_RUN/policy.json" --output "$AUDIT_RUN/compare.json"
cloakium-audit catalog --input "$AUDIT_RUN/compare.json" --input "$AUDIT_RUN/previous-catalog.json" --output "$AUDIT_RUN/catalog.json"
```

`compare` retains raw differences while separating functional capability
differences, within-target headless regressions, iteration instability,
execution errors and environment or version confounders. It assigns a causal
pass or fail only where the evidence points; ordinary value variation is kept as
variation, not promoted to a feature conclusion. `catalog` accepts repeated
`--input` files, merges gap rows by feature id, and preserves provenance and
unknowns. Drop `--policy` when no policy file was recorded.

For a completed, already-closed run whose report codec needs correction, do not
rerun the browsers:

```sh
cloakium-audit finalize --run-dir "$AUDIT_RUN/run" --output "$AUDIT_RUN/report.recovered.json" --reason "recover canonical report"
```

`finalize` reads only the completed run metadata, refuses a live owned identity
or an existing output, preserves the original report, and never launches Node or
a browser.

`references/repeatability.md` contains the diff recipe and the exact IDs to
carry forward.

## Targeted native analysis

Only when a measured gap needs a cause: load `reverse-engineer-anything` and use
its documented REA interface, starting with analysis disabled. One engine owner,
a known checkpoint, the correct triple, selected callbacks via ELF relocation
plus CFI, and selected CFG rather than a whole-binary no-return index. Decode at
true instruction boundaries, not byte patterns, and label completeness honestly.
Full analysis requires an explicit reason, a time and memory budget, and a
bounded wall-clock deadline. On timeout, inspect liveness once and keep the
original job identity; never start a duplicate. Export raw code privately and
never publish it.

Before treating any string or table as recovered behaviour, run the bounded
negative probes in `references/rea-analysis.md`: literal and qualified-name
starts including UTF-16, relocation records rather than C++ structs, CFI stubs
rather than heap type metadata, and emitter presence rather than live execution.

## Integration gates

Report drift instead of papering over it:

- The CLI, JSON schemas and runner are implemented. Re-read `--help` and
  `cloakium-audit schema --name plan` when a flag or schema version is
  uncertain; a mismatch is a contract change.
- `tests/audit/check.mjs` covers the local unit and structural selfchecks only.
  It does not execute a plan or launch a browser.
- `nix profile install .#audit .#audit-display` is the documented installation.
  The audit workflow does not run it for you, and never installs a browser.
- Confirm the final subcommand and flag spelling from `--help` before writing an
  invocation into a report or a test.
