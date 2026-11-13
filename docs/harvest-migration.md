# Harvest migration

Target inspected: the local Harvest worker application.
The application is not modified by building or installing this repository.

## Browser and driver must move together

Harvest currently declares Playwright 1.64.1 and a substantially older Chromium
binary. Its native-fingerprint path also differs from its explicit UA/client-hint
override path. Capture a baseline and migrate the driver and binary as a pair;
do not attribute the effects of an existing mixed identity to a new browser.

Add the flake input:

```nix
inputs.cloakium.url = "github:cloakium/cloakium";
```

Resolve the installed browser from the input's package set, not a proprietary
download URL:

```nix
cloakium-chromium = inputs.cloakium.packages.${system}.chromium;
```

Use `${cloakium-chromium}/bin/cloakium-chromium` in the worker image and developer
shell. Set `CLOAKIUM_BINARY_PATH` to that path. The legacy `CLOAKBROWSER_BINARY_PATH`
is accepted for interoperability, but no background updater exists and no update
environment toggle is needed. Remove the old binary's unfree exception once it
is no longer part of the build.

## Application imports

Install the two package archives from one verified Cloakium release in the
**workers** workspace, where Harvest's authoritative Bun lock lives:

* `cloakium-browser-*.tgz` supplies `@cloakium/browser`.
* `playwright-core-*.tgz` supplies the patched package under the usual
  `playwright-core` import name.

Change the production imports in `workers/web/shared/src/browser.ts` and the audit
entry point to `@cloakium/browser` / `@cloakium/browser/human`. Keep Playwright type
imports from `playwright-core`. The public entry points include `launch`,
`launchContext`, `launchPersistentContext`, `patchBrowser` and `resolveConfig`.

Use the API documentation when migrating options. Compatibility names are not
evidence that a proprietary native switch is implemented. In particular:

* Use genuine Playwright proxy configuration; do not put credentials into a
  Chromium `--proxy-server` argument. Protect credentials from launch logs.
* Configure locale/timezone consistently across native contexts and HTTP headers.
* Configure geolocation/egress identity explicitly. There is no implicit external
  GeoIP service or database download.
* Only documented fingerprint switches have native effects. Remove unsupported
  vendor flags rather than assuming Chromium's silent acceptance means support.
* The input-pacing layer is independently implemented on public Playwright APIs.
  It is not an exact replica of another product's private human-input engine.

The persistent launch returns a real Playwright context. Preserve Harvest's
default-page keepalive and close ownership behavior. Test per-job contexts on a
persistent browser, not just one first page.

## Regenerate and verify

Regenerate `workers/bun.lock` and `workers/bun.nix` through Harvest's normal
dependency owner. Its root Bun lock was older when inspected; do not accidentally
use it to regenerate the worker image dependency tree.

Update the Nix image's browser reference and the Rust structural tests that name
the previous package, hashes and unfree allowlist. Run the worker typecheck, launch
shape, persistent profile, proxy, loop and local browser fixture suites. Then
build the worker image and run its headed/VNC path as well as headless mode.

Audit the existing flags, not only package names. At inspection time, some paths
combined an old Chrome/138 header with a newer browser, claimed a platform different
from the host, or disabled GPU while selecting a software GL backend. Prefer a
coherent native configuration and explicit fixtures over accumulating stale
launch flags.

Do not declare the application migrated until its real worker image and browser
tests have passed. This document is an integration procedure, not a claim that
the separate Harvest application has already been changed.
