# Cloakium

An independently authored, Playwright-only browser toolkit with original MIT
code, source-patched Chromium, a patched Playwright driver and reproducible Nix
installation. No subscription, activation key, paid browser binary or Puppeteer
integration.

This is not a fork of CloakBrowser and includes none of its source or binaries.
It is not a promise that a website will identify automation as a human.

## Install with the flake

```sh
nix profile install --accept-flake-config \
  github:cloakium/cloakium#chromium \
  github:cloakium/cloakium#playwright \
  github:cloakium/cloakium#browser
```

The browser is `cloakium-chromium` (also exposed as `chromium` by its package).
`#browser` is library-only and does not force a native compile. Install the
matching `#chromium` package alongside it. `cloakium-node` provides Node with the
library path in `CLOAKIUM_MODULE` and an importable driver path in
`CLOAKIUM_PLAYWRIGHT_MODULE` (the library itself uses its packaged driver):

```sh
cloakium-node --input-type=module -e '
  const { launch } = await import(process.env.CLOAKIUM_MODULE);
  const browser = await launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
  await browser.close();
'
```

The flake builds from pinned source. A matching signed release cache avoids a
local Chromium compile; without a substitute, expect a large native build.
The default cache serves the latest release. For older pinned versions, add
`--extra-substituters https://github.com/cloakium/cloakium/releases/download/<tag>`
and install `github:cloakium/cloakium/<tag>#chromium` (and the matching packages).
Supported build platforms are Linux x86-64 and ARM64; test evidence identifies
which platform was actually run. Darwin and Windows builds are not supplied.

For a project using Node or Bun, install the `cloakium-browser-*.tgz` and
`playwright-core-*.tgz` assets from the **same** GitHub release. Then:

```ts
import { launch } from "@cloakium/browser";

const browser = await launch({ headless: true });
try {
  const context = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London" });
  const page = await context.newPage();
  await page.goto("https://example.com");
} finally {
  await browser.close();
}
```

Browser resolution uses `CLOAKIUM_BINARY_PATH`, the legacy compatibility variable
`CLOAKBROWSER_BINARY_PATH`, or the installed `cloakium-chromium` executable. Launch
never downloads, updates or licenses a binary. Keep the Chromium sandbox enabled;
containers must provide suitable user namespaces rather than silently disabling it.

## What is tested

* Strict native patch replay against the locked Chromium source.
* Strict driver source-shape checks; no silently skipped patches.
* Ordinary Playwright objects, contexts, persistent profiles and proxy options.
* Original, opt-in input pacing using public Playwright APIs.
* Local browser fixtures and native fingerprint regression tests, with immutable
  source pins and patch hashes recorded in release evidence.

## Implemented surfaces

| Surface | Implementation |
| --- | --- |
| Automation and headless markers | Native WebDriver value and coherent JS/HTTP UA in fingerprint mode. |
| Canvas | Seeded, origin-scoped, non-mutating readback changes, including OffscreenCanvas. |
| Audio | Deterministic offline-audio changes applied once, not accumulated on reads. |
| Hardware and WebGL | Explicit native settings; real host values remain the default. |
| WebRTC egress | Browser-wide non-proxied UDP blocking, verified with a local STUN responder. |
| Driver observability | Runtime-domain setup is disabled by default; isolated-world names are randomized. |
| Contexts | Persistent profiles, workers, frames, bindings, tracing and ordinary Playwright objects. |
| Sandboxing | Enabled by default, with real namespace/seccomp checks and an explicit opt-out. |
| Input | Opt-in pointer curves, key pacing, wheel notches and touch pacing using browser input. |

The library enables native fingerprint mode with a seed by default. Direct
browser invocations must supply `--fingerprint=<seed>`. Console/page-error
capture requires the documented Runtime-domain opt-in; it is not silently
re-enabled. Locale/timezone settings use Playwright's context APIs without
pretending the host is another operating system.

See the exact [native patches](docs/native-patches.md),
[Playwright changes](docs/playwright-patches.md), [API](docs/api.md) and
[research boundaries](docs/research.md). Detector scores, physical-input identity,
CAPTCHA handling and a perfect copy of any proprietary product are not guaranteed.

## Automatic updates

Every six hours Actions checks stable Playwright and the Chromium recipe in
nixpkgs. A successful no-op stays a no-op. A changed pair is patched and tested on
an update branch; a dedicated builder then compiles and verifies the native
browser. A separate trusted publisher signs the output, stages a complete draft,
checks freshness, promotes the verified candidate and publishes the release.

Failures retain diagnostics and leave the last verified release intact. Patches
are never automatically discarded to make an update green. Network, compiler,
test and infrastructure failures remain visible alongside patch conflicts.

The repository needs a sufficiently large builder and its signing secret; see
[builder setup](docs/builders.md). GitHub Releases hosts the signed cache without
a paid cache service. Free software does not eliminate compute costs.

## Development and Rust tools

```sh
nix develop
nix run .#maintain -- --help
nix build .#chromium-patch-check .#playwright .#browser
nix build .#chromium --cores 16 --max-jobs 1 -L
```

Update, patching and release tooling is Rust and is built through the flake.
Playwright integration is TypeScript; native browser changes are C++. No
Cloakium-authored Python tooling is used. Chromium's own build system retains its
upstream tooling.

[Architecture](docs/architecture.md) · [Harvest migration](docs/harvest-migration.md) ·
[Security](SECURITY.md)

## License

Original Cloakium code and patches: [MIT](LICENSE). Chromium, Playwright and their
dependencies retain their own licenses and notices. The complete browser binary
is not exclusively MIT; upstream credits are preserved.
