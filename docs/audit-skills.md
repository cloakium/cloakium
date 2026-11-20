# Audit skills

Three project-local OpenCode V2 skills capture the reusable part of the browser
audit, discovery and update workflows. They are original MIT instructions, not
copies of vendor documentation.

| ID | Load | Use |
| --- | --- | --- |
| `cloakium-audit-private` | `@cloakium-audit-private` | Audit one explicitly named binary, launcher, artifact or repository privately |
| `cloakium-discover-browsers` | `@cloakium-discover-browsers` | Find and classify candidate Chromium forks and wrappers with receipts |
| `cloakium-update-chromium` | `@cloakium-update-chromium` | Prepare, validate and gate a Chromium/Playwright pin update |

The IDs are path-derived from `.opencode/skills/<id>/SKILL.md`. The frontmatter
`name` is a display label only. Every skill has a `description`, so it is
advertised by default; none sets `metadata.opencode/autoinvoke`, because these
skills should be discoverable. Project `.opencode/skills` overrides a global
skill with the same ID, so a checkout pins its own instructions.

No project configuration is required: OpenCode discovers `.opencode/skills`
automatically. The authoritative V2 reference is
<https://opencode.ai/docs/skills>; supporting paths inside a skill are relative
to that skill's directory.

## Layout

```text
.opencode/skills/
├── cloakium-audit-private/
│   ├── SKILL.md
│   └── references/
│       ├── cli-receipt.md
│       ├── evidence-and-layers.md
│       ├── network-and-failure.md
│       ├── private-outputs.md
│       ├── rea-analysis.md
│       └── repeatability.md
├── cloakium-discover-browsers/
│   ├── SKILL.md
│   └── references/
│       ├── classification-and-receipts.md
│       └── catalog-contract.md
├── cloakium-update-chromium/
│   ├── SKILL.md
│   └── references/
│       ├── gates.md
│       └── recovery.md
└── tests/
    ├── validate.rs
    ├── validate/
    │   ├── parse.rs
    │   ├── skill.rs
    │   └── sources.rs
    └── README.txt
```

`tests/` holds no `SKILL.md`, so it is not a skill. Supporting files are loaded
only when a skill directs the agent to read them. The audit unit aggregate lives
outside the skills at `tests/audit/check.mjs`.

## What each skill enforces

`cloakium-audit-private` requires an explicit target, separates engine, launcher,
driver, client, probe-set and font provenance, reuses only matching checkpoints,
and keeps private output outside the checkout. It records five network paths with
positive controls, maps native probe outcomes to the canonical `Check.status`
(`pass`, `fail`, `unknown`, `unsupported`, `error`) while retaining the original
tri-state detail, and separates executed coverage from an all-pass `complete`.
It preserves intentional fail-closed behaviour and writes reports atomically.
Targeted native analysis is bounded, labelled for completeness and kept private.

`cloakium-discover-browsers` starts from `get_me`, searches in bounded batches,
and classifies each candidate on separate kind, source, license, engine,
automation, platform, headless and freshness axes. It records source URL, UTC
retrieval time, commit and license digests, treats README claims as untrusted, and
never downloads or executes a candidate. Acquisition is a separate, explicitly
selected step with checksum and license verification.

`cloakium-update-chromium` uses the existing Rust automation:
`cloakium-maintain update [--root PATH] [--refresh-toolchain]` and
`validate-update --base ROOT --candidate DIR`. It stages only the five allowed
paths, records the Playwright reference build and native pin as separate facts,
and gates on strict patch replay, package builds, type checking, unit tests, the
native build, and headless/headed parity in both profile variants. It never
commits, pushes, signs or publishes unless the user asks, and never prints key
material.

## Validation

The validator is dependency-free Rust. It checks frontmatter, ID shape, unique
display names and descriptions, MIT license, advertised-by-default state, file
size, relative reference integrity, cross-skill `@id` references, shell-command
names in examples, documented repository paths, `npm` script existence,
`cloakium-maintain` subcommands and flags against `tools/maintain/src/main.rs`,
and the `cloakium-audit` contract source-gated from
`tools/browser-audit/src/cli.rs` (never from a one-line `mod cli` in `main.rs`).
With `--help-check` it also parses the real `--help` output of
`tests/parity/run.mjs` and `tests/parity/fullscreen.mjs`.

CI can build and run it without `nix develop`, because it needs only `rustc`:

```sh
rustc --edition 2021 -O .opencode/skills/tests/validate.rs -o "$RUNNER_TEMP/cloakium-skill-validate"
"$RUNNER_TEMP/cloakium-skill-validate" .opencode/skills --help-check \
  --audit-bin "$(nix build .#audit --print-out-paths)/bin/cloakium-audit"
```

`--audit-bin` replaces the source-derived flag set with the real `--help` and
each subcommand's help, and fails on any documented subcommand or flag the binary
does not list. The current help snapshot is
`.opencode/skills/cloakium-audit-private/references/cli-receipt.md`.
`--help-check` is skipped with a `SKIP` line when Node or `node_modules` is
absent. The validator itself never needs a browser, a network or a secret.
Formatting is checked separately:

```sh
rustfmt --edition 2021 --check .opencode/skills/tests/validate.rs .opencode/skills/tests/validate/*.rs
```

Current result: 64 checks passed, 0 failed. The count follows the contract
surface: subcommands, flags and help output are parsed from
`tools/browser-audit/src/cli.rs` and `tools/maintain/src/main.rs`.

Run it after editing a skill or its references. A new shell command, path or
frontmatter field that the validator rejects is a contract change, not noise:
update the skill or the validator deliberately, never by loosening the check to
fit an invented command.

## Local audit units

`tests/audit/check.mjs` is the aggregate local unit and selfcheck runner. The
package script `test:audit:unit` is expected to be `node tests/audit/check.mjs`;
the aggregate is deliberately not part of `npm test`, so it cannot recurse into
the normal package suite.

```sh
node tests/audit/check.mjs
node tests/audit/check.mjs --list
node tests/audit/check.mjs --help
```

It runs, sequentially and fail-fast under one ten-minute wall clock:

- every `tests/audit/**/*.test.mjs` discovered dynamically, including the
  `fingerprint`, `profile-lifecycle`, `additional` and `lib` suites;
- the browser-contracts, extended-network and wire-identity selfchecks;
- the network syntax, manifest, profile-fixture, H3-fixture and source-guard
  selfchecks, plus the network lab when an OpenSSL CLI is available;
- the request-path syntax and lab selfchecks.

`--list` and `--help` are read-only. `--timeout-ms` may shorten, never extend,
the budget. Each child's success line carries its real counts; a failure prints
only the last 30 lines, truncated, and exits 1 immediately.

Unit boundaries: no browser is launched. The browser integration test is forced
to skip by removing its `CLOAKIUM_AUDIT_TEST_*` variables, and
`request-paths/selfcheck/browser.mjs` is excluded because it launches Chromium.
The H3 fixture self-skips unless `CLOAKIUM_H3_BIN` or a built
`tools/audit-h3-lab` target exists. To run it against the Nix package:

```sh
export CLOAKIUM_H3_BIN="$(nix build .#audit-h3-lab --print-out-paths)/bin/cloakium-lab-h3"
node tests/audit/check.mjs
```

The network lab selfcheck needs `OPENSSL_BIN` or `openssl` on `PATH`; the lab's
minimal fixture environment cannot find a Nix store binary by name, so the
runner passes an absolute path.

`tests/audit/check.test.mjs` verifies that `--help` and `--list` stay read-only,
that the planned paths exist and are unique, and that the browser probe is not
listed.

## Source snapshots

`tests/audit/lib/snapshot.mjs` exports `snapshotSources(sourceRoot, destination,
manifest)` for the runner to archive the exact source that produced an audit.
The manifest is the existing `sourceManifest` shape, `{files:[{path,sha256}],
sha256}`; only listed files are copied, so later helper files do not pollute an
older snapshot.

- Paths must be relative, with no `..`, absolute path, NUL, backslash or control
  character. Only `mjs`, `js`, `json`, `rs`, `toml`, `lock`, `md`, `html`, `css`
  and `txt` sources are accepted, and `node_modules`, `target`, `reports`,
  `evidence`, `.git` and `.jj` are refused.
- The source file must be regular with no symlink at any ancestor inside the
  root. Each source hash must equal the manifest before and after the copy.
- The destination must be fresh, owned, mode 0700; files are created exclusively
  at mode 0600. A pre-existing destination or copied path is refused.
- Every copied file is hashed and must equal the manifest entry. The manifest is
  written atomically after the files.
- Returns `{directory, files, sha256, manifestFileSha256, verified:true}`.

`tests/audit/lib/snapshot.test.mjs` covers mutation mismatch, symlink file and
ancestor, traversal, disallowed paths, pre-existing destination, tampered
aggregate, empty manifest, copied modes and manifest self-verification.
The runner integrates this automatically at
`<output>/source-snapshot/tests/audit`, moving the manifest outside the code tree.
That layout keeps relative imports and the original source manifest replayable.

Probe-only suites also share one owned HTTP fixture for a whole plan.
`suiteOptions.sharedFixture.port` defaults to `0`; explicit replay ports must
come from an earlier receipt and be free. Actual scheme/hostname/port identity,
not just a fixture label, is required for seed/noise parity across modes or
versions. Proxy and persistent-profile scenarios remain separately owned.

Behaviour runs are not units. `node tests/audit/run.mjs --plan ABS --output ABS`
executes a validated plan and needs an explicit browser and client;
`cloakium-audit run` wraps it with one process group and a deadline. Neither is
part of `test:audit:unit`.

## Reports, seats and witness

The Node runner writes `<output>/runner-report.json` with schema
`cloakium.audit.runner/1`. Rust freezes that fragment and writes the final
`<output>/report.json` with schema `cloakium.audit.report/1`; only the Rust
owner writes the final report.

`complete: true` means a valid, complete plan, one accepted run per
configuration, every observation `observed` with at least one functional check,
every check `pass`, clean cleanup, confirmed hashes and no error, unknown,
unsupported, skipped, coverage-gap or timeout row. A valid report with an
observed capability gap is `complete: false` and is not an execution failure.
Node exits 0 when every selected probe executed and cleanup was clean, even when
a check failed; an exception row is an execution error and exits 1. Rust `run`
exits 0 complete, 2 incomplete-but-written, 1 preflight failure.

`run` and a direct Node run share the seat lease
`/tmp/opencode/cloakium-audit-seat-<uid>`, owned by `pid:startTicks` and never
stolen. `recoverStaleSeat` is manual and requires verified owned children gone.
The passive `socket-witness` reports sampled Linux socket inodes with
`absenceEstablished: false`; absence is never zero-egress proof.

## Integration gates

The audit stack is present in this tree:

- `tools/browser-audit` builds `cloakium-audit` with `inventory`, `plan`,
  `validate`, `run`, `finalize`, `compare`, `catalog` and `schema`; the flake
  exports `.#audit`, `.#audit-display` and `.#audit-h3-lab`, with apps `audit`
  and `audit-display`.
- `tests/audit/schema` publishes the strict plan, report, runner, execution,
  policy, inventory, compare and catalog schemas; the binary embeds the same
  files.
- `tests/audit/run.mjs` implements the runner protocol
  (`--plan ABS --output ABS`) and `cloakium-audit run` wraps it with one process
  group, a wall-clock deadline and a cleared environment.
- `tests/audit/check.mjs` is the local unit aggregate described above.

Re-read `--help` and `schema --name` when a flag or version is uncertain; report
drift rather than inventing a flag. The discovery claim catalog
(`cloakium.audit.sources/1`) is separate from the merged gap catalog
(`cloakium.audit.catalog/1`).

When a subcommand, flag or schema changes, update the skill and the validator
together. Do not hand-edit the catalog format.
