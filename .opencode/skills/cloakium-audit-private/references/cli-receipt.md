# Verified CLI receipt

Snapshot of the built binary help, not a substitute for `--help`.

- Binary: `/nix/store/widys0ggd7mlyi8xa799mq4xlhg4q479-cloakium-audit-0.1.0/bin/cloakium-audit`
- Contract: `tests/audit/schema/SCHEMA.md`, `cloakium.audit.*/1`
- Parent smoke: `validate --plan smoke-002` reported `valid=true`,
  `complete=false` with one iteration, which is a valid but incomplete plan.

## Subcommands

| Command | Required inputs | Notes |
| --- | --- | --- |
| `inventory` | `--plan` or `--artifact` | Artifact must be native Linux ELF; launcher may be ELF or trusted shebang script; never executed |
| `plan` | `--baseline --candidate --client-module --output` | Both modes; `--iterations` default 2; `--locale` default `en-US`; `--suite` default `fingerprint` |
| `validate` | `--plan` or `--report` | Validity is separate from completeness |
| `run` | `--plan --node --runner` | `--timeout` default 3600 s; optional `--output`, `--suite-manifest`, `--lock` |
| `finalize` | `--run-dir --output` | Closed-run report recovery; optional `--reason`; never runs Node or a browser |
| `compare` | `--baseline --candidate --output` | Optional `--plan`, `--policy`, target ids, `--force` |
| `catalog` | `--input --output` | `--input` repeatable; `--force` |
| `schema` | none | `--name plan|report|runner|policy|compare|catalog|inventory|execution` |

Common flags verified on `inventory`: `--plan`, `--artifact`/`--binary`,
`--launcher`/`--executable`, `--client-module`, `--id`, `--label`, `--layer`,
`--identity`, `--arg`, `--headless-arg`, `--headed-arg`, `--output`, `--force`.

Common flags verified on `plan`: `--baseline`, `--candidate`,
`--baseline-launcher`, `--candidate-launcher`, `--client-module`,
`--iterations`, `--output`, `--force`, `--environment-id`, `--locale`,
`--timezone`, `--fontconfig-file`, `--fontconfig-path`,
`--font-manifest-sha256`, `--display-kind`, `--width`, `--height`, `--depth`,
`--dpi`, `--window-manager`, `--display-name`, `--xauthority`,
`--ownership-manifest`, `--notes`, `--suite`, `--probe`, `--scenario`,
`--suite-option`, `--probe-config`, `--seed`, `--baseline-layer`,
`--candidate-layer`, `--baseline-identity`, `--candidate-identity`.

`run` flags: `--plan`, `--node`, `--runner`, `--output`, `--timeout`,
`--suite-manifest`, `--lock`.

`finalize` flags: `--run-dir`, `--output`, `--reason`.

`compare` flags: `--baseline`, `--candidate`, `--policy`, `--plan`, `--output`,
`--baseline-target`, `--candidate-target`, `--force`.

## Profile repeatability

Every target/profile/scenario needs both headless and headed configurations,
with iterations contiguous from 1 and at least two per mode. One iteration is
valid but incomplete, as a smoke plan may be. `validate` reports the missing
mode/iteration as an incomplete reason; it does not silently accept a short
matrix as complete.

## Exit and completeness

- `run`: 0 complete, 2 written-but-incomplete, 1 preflight failure.
- `finalize`: writes a new report from a closed run; an existing output or a
  live owned identity is refused.
- Report `complete: true` requires every planned configuration and every check
  to pass with clean cleanup and no unknown/unsupported/skipped/error rows.
- A valid plan or report with observed capability gaps is `complete: false`,
  not an execution failure.
- Node runner: exit 0 when all selected probes executed with clean cleanup even
  if a check failed; an exception row is an execution error and exits 1.

## Validation gate

```sh
"$RUNNER_TEMP/cloakium-skill-validate" .opencode/skills --help-check --audit-bin "$(nix build .#audit --print-out-paths)/bin/cloakium-audit"
```

`--audit-bin` replaces the source-derived flag set with the real help output and
fails on any documented subcommand or flag that the binary does not list.
