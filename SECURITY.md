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
