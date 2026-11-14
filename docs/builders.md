# Release builders

The project charges no license fee. Compute, storage and network resources still
have real costs; a free public GitHub repository does not supply a Chromium-sized
runner.

Use a dedicated Linux builder with at least 150 GiB free disk and preferably
64 GiB RAM / 16 cores. Ordinary hosted GitHub runners do not have enough usable
disk for a full Chromium build. The small hosted jobs only validate patches,
compile Rust tools and build the Playwright/library packages.

## NixOS

The root flake exports a builder module:

```nix
{
  imports = [ inputs.cloakium.nixosModules.cache inputs.cloakium.nixosModules.builder ];
  services.cloakium-builder = {
    enable = true;
    tokenFile = "/run/secrets/cloakium-runner-token";
  };
}
```

Deploy the token through your secret manager, never a literal Nix string or a
committed file. It needs repository-scoped runner administration, not access to
unrelated repositories. The module uses an isolated system account and ephemeral
runner registrations; use an access token rather than a one-hour registration
token so re-registration works.

The default runner labels are `self-hosted`, `linux`, `x64`, `cloakium-chromium`.
For an appropriately sized hosted runner, set the repository variable
`CLOAKIUM_BUILD_RUNNER` to a JSON array containing that runner's label. Hosted
larger runners may require a paid GitHub plan and incur charges.
For an ARM64 self-hosted builder, use
`["self-hosted","linux","arm64","cloakium-chromium"]`. An exported ARM64 package
is not a claim that an ARM64 binary has already been built or tested.
Set `CLOAKIUM_SYSTEM=aarch64-linux` when targeting that architecture.

Driver-only updates use a hosted runner when the exact native closure and its
signatures are already available in the cache. It imports that closure without
a build fallback. A new native derivation still requires the large builder;
the workflow never attempts a cold Chromium compile on a small hosted runner.

## Signing

Generate one binary-cache key pair through the flake's Nix environment:

```sh
umask 077
nix develop -c nix-store --generate-binary-cache-key cloakium-1 /secure/path/signing.key cache-public-key.txt
gh secret set NIX_SIGNING_KEY --env release < /secure/path/signing.key
```

Restrict the `release` environment to the `main` branch. Keep `signing.key`
outside the checkout. Commit only `cache-public-key.txt` and
the corresponding public key in the flake's cache configuration. Never put an
unsigned cache into the default trusted installation path.

Release builds are dispatch-only and never run on a PR event. Keep this runner
off a general-purpose desktop and out of a network containing unrelated secrets.
Ephemeral runner registration alone is not a VM security boundary.

## Initial local bootstrap

Before a dedicated builder is registered, a verified local build can supply the
first release. Stage an unsigned cache using `cloakium-maintain release
--unsigned`, upload its assets to an unpublished draft, and dispatch
`release.yml` with `bootstrap_tag` naming that draft. The commit must be current
`main`. The isolated hosted publisher validates the complete cache and test
evidence, signs it, and attests the checksums without executing the local payload.

The evidence records whether tests ran locally or in Actions. Bootstrap
attestation covers publication/validation, not an assertion that GitHub compiled
the browser. Recurring upstream releases still require the dedicated builder.

## Local builds

```sh
nix build .#chromium-patch-check
nix build .#chromium .#playwright .#browser --cores 16 --max-jobs 1 -L
```

The source-only patch check is intentionally separate from the native build.
Passing it does not establish that the browser compiles or works.
