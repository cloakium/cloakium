# Gates and ownership

Every gate is recorded as passed, failed or blocked with the exact command and
the first decisive error line. A blocked gate is not a pass.

| Gate | Command | Failure owner |
| --- | --- | --- |
| Candidate preparation | `nix run .#maintain -- update --root .` | network, npm registry, nixpkgs |
| Pin validation | `nix run .#maintain -- validate-update --base . --candidate artifacts/candidate` | candidate contents or maintain tooling |
| Flake evaluation | `nix flake check . --all-systems --no-build` | metadata or flake wiring |
| Patch replay | `nix build .#chromium-patch-check -L` | upstream source shape or patch |
| Driver build | `nix build .#playwright -L` | driver source shape |
| Package builds | `nix build .#browser .#launcher -L` | library, launcher or Nix wiring |
| Type checking | `nix develop . -c npm run typecheck` | TypeScript source |
| Unit and API | `nix develop . -c npm test` | library behaviour |
| Native build | `nix build .#chromium --cores 16 --max-jobs 1 -L` | builder capacity or compiler |
| Runtime verification | `nix develop . -c env CLOAKIUM_BINARY_PATH="$BINARY" node tests/verification/verify.mjs` | a specific behaviour gate |
| Parity | `npm run test:parity` | engine or adapter behaviour |
| Native-defaults parity | `npm run test:parity -- --native-defaults` | Playwright implicit defaults |
| Fullscreen reference | `npm run test:parity:fullscreen` | window/geometry contract |

## What must not be loosened

- Strict patch replay with zero fuzz. A rejected hunk retains `.rej` files; it is
  never dropped to make the build green.
- The five-pin allowlist. A sixth changed file is a validation failure.
- Sandbox and namespace checks. Do not add `--no-sandbox` or set
  `CLOAKIUM_TEST_NO_SANDBOX=1` to pass a gate.
- Parity acceptance: no failed probes, no unstable observations, no unexplained
  cross-mode differences.
- Signed artifact verification for anything that will be published.

## Version distance is not a gate

`playwright.chromiumVersion` and `chromium.version` can differ without making the
pair unsupported. Record the difference, the source revisions and the evidence
that actually ran. A heuristic must not replace the tested pair.

## Evidence to retain

- updater stdout workflow fields;
- validator output;
- `.rej` files and the patch name on replay failure;
- `nix log .#chromium` on native failure;
- parity JSON reports and `verification.json`;
- the resolved revision the evidence belongs to.

Evidence from a different revision than the one being released is not evidence
for that release.
