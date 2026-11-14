# Architecture

Cloakium is an independently authored, Playwright-only alternative, not a fork of
a proprietary browser or a payment/license-check workaround.

## Components

* **Chromium** comes from the locked nixpkgs source recipe. Original native patch
  files are replayed with zero fuzz. The executable wrapper must reference the
  patched unwrapped derivation, including its sandbox helper.
* **Playwright** comes from a fixed-hash `playwright-core` npm archive. An original
  Rust patcher validates expected source shapes and writes a patched package.
  The public Playwright API remains the integration boundary.
* **Browser library** is original TypeScript. It resolves an explicitly installed
  browser, configures coherent native contexts and exposes ordinary Playwright
  objects. Optional input pacing uses public Playwright APIs.
* **Maintenance** is Rust, built and installed through Nix. It prepares upstream
  candidates and produces signed, checksummed release assets. It never downloads
  a browser implicitly when an application launches.

There is one release owner and one flake rather than loosely synchronized
repositories. Browser, driver, patch digests and the complete Nix input lock are
recorded together. There is no Puppeteer integration.

`playwright.chromiumVersion` records Playwright's reference Chrome-for-Testing
build, while `chromium.version` records the actual source-built stable browser.
Their version difference is recorded, not treated as proof of incompatibility.
Reference builds can advance independently of the stable browser. Strict patch
replay and real integration tests gate the actual pair; signed evidence must
match the exact native and driver versions being released.

## Update transaction

1. A six-hour scheduled job checks the latest stable Playwright npm release and
   refreshes nixpkgs. Chromium release detection follows nixpkgs packaging, so
   it can lag Google's release announcement.
2. An unchanged browser/driver pair is a successful no-op. Toolchain-only refresh
   is an explicit maintenance operation, avoiding a Chromium rebuild on every
   unrelated nixpkgs commit.
3. Source replay, driver build, library type checking and unit tests gate creation
   of an immutable candidate branch. A failure retains diagnostics, not a broken
   `main` update.
4. A signed native cache hit runs on a free hosted runner, with no compiler
   fallback. A cache miss requires an adequately sized native builder. Both paths
   run integration tests against that exact executable and patched driver.
5. Unsigned output data moves to a separate hosted publisher. Trusted-main Rust
   tooling validates it and signs it without executing candidate binaries. A fully
   uploaded draft and a freshness check gate promotion of the verified candidate.
   Only then is the completed release made public/latest. Failed builds do not
   replace the last good release.

Upstream source changes, compiler failures, tests, unavailable registries and
runner problems can all fail a job. It would be misleading to promise that only
patch conflicts can fail. Every failure must be visible rather than silently
dropping a patch or falling back to a different browser.

## Free binary distribution

The release assets form a flat, signed Nix binary cache. NAR archives and narinfo
files are individually uploaded to GitHub Releases; no paid cache service is
required. The unsigned builder/publisher handoff uses an exact per-run Actions
cache key, bounded below the default 10 GiB free cache limit, not multi-gigabyte
Actions artifacts. The cache is addressed through a release's download URL. Rewriting a
narinfo's archive URL does not change its signed Nix path fingerprint.

The flake's `latest/download` substituter is a current-release convenience. For
an older pinned revision, use that release's immutable `releases/download/<tag>`
cache URL; old paths need not remain in the newest release. A cache miss never
changes source pins or substitutes a different browser.

The signing secret lives only in the `release` environment and a mode-0600
temporary file on the publisher. That environment accepts `main` workflow runs
only. Its public key is committed. Checksums cover every asset;
A public Sigstore keyless signature binds the checksum file to GitHub's OIDC
workflow identity; its bundle is a small workflow artifact. Nix signatures authenticate
cache paths independently of HTTPS redirects.

Candidate tests never receive repository-write or signing credentials. A separate
proposal job validates pin-only JSON/lock changes using trusted-main code before
creating the update branch. The native builder similarly has read-only access;
its output artifacts are data, not publication scripts.

The Rust uploader hashes local assets, resumes only missing or differing draft
assets, and verifies GitHub's server digests before promotion. Uploads are serial,
spaced eight seconds apart, and capped at 440 content operations per rolling hour.
Rate-limit retries back off within a single three-hour deadline. A fresh cache
release can therefore take roughly two hours to upload without bursting API limits.

## License boundary

Original Cloakium source and patches are MIT. A modified Chromium binary still
contains Chromium's BSD-licensed code and its third-party components. The patched
Playwright package retains Apache-2.0 and its NOTICE. Calling those upstream
artifacts wholly MIT would be incorrect. Their original license files and browser
credits must remain available in distributed outputs.
