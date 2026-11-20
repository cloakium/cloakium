---
name: Cloakium Chromium update
description: Prepare, validate and gate a Cloakium Chromium and Playwright pin update using the existing Rust maintenance tooling. Use when the user asks to update Chromium, refresh nixpkgs, bump playwright-core, or replay patches against a new candidate. It prepares and proves a candidate; it never commits, pushes, signs or publishes unless the user asks, and never prints keys.
license: MIT
---

The update path is already implemented in Rust. Use it; do not hand-edit pins,
do not add a parallel updater, and do not mutate pins for a tooling-only task.

## Hard boundaries

- No commit, bookmark, push, tag, signing, upload or publication unless the user
  explicitly asks. Prepare evidence; stop there.
- Signing keys are read by Nix from a file path. Never print, hash, copy or pass
  key contents on a command line. Never echo `NIX_SIGNING_KEY`.
- Keep the user's jj configuration intact. Never run `jj` with a blanked config,
  and never run a bare `jj describe`; if a description is requested, pass `-m`.
- No naked git commands as a workaround. Version control is `jj`.
- No npm global installs. Packages come from the flake's user-install path.
- Keep Chromium's sandbox enabled. A namespace failure is a blocked gate, not a
  reason to disable it.

## Step 1 — record the base

```sh
jj status
jj log -r @ --no-graph -T 'commit_id ++ " " ++ description.first_line() ++ "\n"'
jj diff -- flake.lock upstream.json package.json package-lock.json nix/npm-deps-hash.nix
```

Record the resolved revision. If the last command prints anything, stop and get a
decision: the updater rewrites those five tracked files and must not silently
overwrite user edits. Unrelated untracked files are not a conflict.

If `.envrc` and `flake.nix` both exist, use `direnv reload`. This checkout has
`flake.nix` without `.envrc`, so the `nix develop` and `nix run` forms below are
correct here.

## Step 2 — prepare the candidate

The updater tracks the latest stable `playwright-core`, reads Chromium's pin from
that package's `browsers.json`, refreshes the nixpkgs lock and rewrites only the
metadata it owns. It publishes nothing.

```sh
nix run .#maintain -- update --root .
```

It needs network access for `npm view` and `nix flake update nixpkgs`. Record
its workflow fields: `changed`, `playwright`, `chromium`.

- `changed=false` is a successful no-op. Stop; do not invent a diff.
- An unchanged pair with an intentionally refreshed toolchain is the explicit
  maintenance operation:

```sh
nix run .#maintain -- update --root . --refresh-toolchain
```

Do not treat a toolchain-only refresh as a Chromium update, and do not rebuild
Chromium for an unrelated nixpkgs commit.

## Step 3 — stage only the allowed files

An update may touch exactly five paths:

```sh
mkdir -p artifacts/candidate/nix
cp flake.lock upstream.json package.json package-lock.json artifacts/candidate/
cp nix/npm-deps-hash.nix artifacts/candidate/nix/
```

Anything else in the candidate is a validation failure, not a file to add to the
allowlist.

## Step 4 — validate the candidate

```sh
nix run .#maintain -- validate-update --base . --candidate artifacts/candidate
```

The validator accepts only the five metadata paths, the `playwright-core`
dependency pin and the nixpkgs refresh. It checks that `package.json`,
`package-lock.json` and `upstream.json` agree, and that `flake.lock` changes only
`nodes.nixpkgs.locked`. Record any rejection verbatim. Never widen the allowlist
to make a candidate pass.

A whole checkout (`--candidate .`) is validated on metadata paths only, so build
outputs and `node_modules` do not fail it. A bare metadata directory is validated
strictly and may contain nothing else.

## Step 5 — record the version difference honestly

`upstream.json` carries two different facts:

- `playwright.chromiumVersion` is Playwright's reference Chrome-for-Testing build;
- `chromium.version` is the source-built stable browser.

Their distance is information. It is not proof of incompatibility, and it is not
grounds to mark a pair unsupported. The tested driver+native pair decides.
Record both values, the reference revision and the test evidence that actually
ran. Never replace this with a version heuristic.

## Step 6 — source and package gates

```sh
nix flake check . --all-systems --no-build
nix build .#chromium-patch-check .#playwright .#browser .#launcher -L
```

```sh
nix develop . -c npm ci --ignore-scripts --no-audit --no-fund
nix develop . -c npm run typecheck
nix develop . -c npm test
```

Strict patch replay runs with zero fuzz. A rejected hunk is a real failure:
retain the `.rej` diagnostics and never drop a patch to make the build green.

## Step 7 — native build gate

```sh
nix build .#chromium --cores 16 --max-jobs 1 -L
```

A cold native build needs the dedicated builder described in `docs/builders.md`.
Ordinary hosted runners do not have the disk. If the build cannot run, capture
the precise blocker and leave the gate open:

```sh
nix log .#chromium
```

Do not mark the update passed because the source patch check passed. Passing
replay does not establish that the browser compiles or works.

## Step 8 — mandatory runtime and parity gates

Every improvement and every regression fix must pass headless in both profile
variants and the public launcher integration. Set `BINARY` to the launcher build
under test, for example `result-browser/bin/cloakium-chromium`:

```sh
nix develop . -c env CLOAKIUM_BINARY_PATH="$BINARY" node tests/verification/verify.mjs
```

That verifier runs the browser version assertion, library build, typecheck,
unit/API suites under Node and Bun, driver regressions, native regressions,
parity unit tests, headed/headless parity, native-defaults parity and the
fullscreen reference. Point `CLOAKIUM_BINARY_PATH` at the public launcher
(`result-browser/bin/cloakium-chromium`) so the launcher path is covered, not
only the unwrapped engine.

If the full verifier cannot run, run the same gates individually and report the
gap:

```sh
nix develop . -c env CLOAKIUM_BINARY_PATH="$BINARY" npm run test:parity
nix develop . -c env CLOAKIUM_BINARY_PATH="$BINARY" npm run test:parity -- --native-defaults --output artifacts/parity/release-native.json
nix develop . -c env CLOAKIUM_BINARY_PATH="$BINARY" npm run test:parity:fullscreen
```

Parity acceptance: no failed probes, no unstable observations, no unexplained
cross-mode differences. A headed-only difference that disappears with
`--native-defaults` is an adapter default, not an engine regression. Preserve
intentional Linux, real-hardware, WebRTC and proxy-key fail-closed behaviour.

## Step 9 — stop before publication

Do not run `release`, `sign-release`, `upload-release` or `verify-publication`
unless the user asks for a release. When they do:

- pass `--signing-key` as a path only;
- never print the key, its digest or the secret value;
- keep the signed `.github/workflows/release.yml` boundary intact: the release
  environment accepts trusted `main` runs only, as documented in `SECURITY.md`;
- never promote a draft whose upload or freshness check did not complete.

## Recovery

`references/gates.md` maps each failure to its owner and the evidence to keep.
`references/recovery.md` covers a partially written candidate and the safe way to
discard only the five metadata files after the user agrees.

If `update` reports a network, registry or nixpkgs failure, retain its output and
stop. A failed refresh is not an unchanged pair.
