# Security

Report vulnerabilities privately through GitHub's **Report a vulnerability**
button. Do not publish proxy credentials, profile contents or browsing history.

Keep Chromium current. Browser fingerprint privacy is not a security sandbox:
run untrusted pages as an unprivileged account and keep Chromium's sandbox enabled.
Do not expose the debugging transport to a network.

Public pull requests run only on disposable hosted runners. The release workflow
is dispatch-only, accepts immutable commits from `main` or validated pin-only
update branches, and must use a dedicated builder. Builds/tests have read-only
access. A separate publisher uses trusted-main tools and validates unsigned
artifacts before signing; it never executes candidate code. Do not attach a
general-purpose workstation or a runner with unrelated credentials to a public
repository.

The signing key belongs in the `release` environment's `NIX_SIGNING_KEY` secret.
Restrict that environment to workflow runs from `main`.
Only its public key is committed. Treat a key compromise as a release incident:
rotate the key, update the flake's trusted public key and notify consumers.

Release checksums also receive a public Sigstore keyless signature bound to the
`release.yml` workflow on `main`. Its bundle is the small `release-provenance`
workflow artifact; the public transparency log retains the signing record. This
does not require GitHub's separately gated attestation-storage API.

Verify a downloaded bundle and checksum file with:

```sh
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/cloakium/cloakium/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
