# Headed/headless parity

The parity suite executes the same interactions against the same source-built
Chromium and patched Playwright in both modes. It compares browser observations,
not a third-party detector score.

## Test environment

The headed reference uses a private Xvfb screen at 1920×1080, 96 DPI. The
Chrome-only reference has no external window manager; an Openbox reference can
also expose desktop-specific effects. The harness clears inherited Wayland
state so it cannot accidentally use the user's desktop. Headless processes
receive neither `DISPLAY` nor `WAYLAND_DISPLAY`: a virtual display is **not**
a production dependency.

Both modes use the same fingerprint seed, locale, timezone, window position,
browser arguments, fixture origins, and context options. Probes normally use
a fixed viewport; geometry probes disable viewport emulation. Every probe has
a fresh context and functional assertions, so two equally broken interactions
cannot count as a successful comparison.

## Coverage

| Area | Exercises |
| --- | --- |
| Input | Typing, editing shortcuts, forms, focus traversal, scrolling, hover, drag/drop, trusted event properties, touch |
| Windows | Popups, dialogs, fullscreen, pointer lock, file upload/download, same-origin and cross-origin frames |
| Environment | HTTP/JavaScript UA coherence, client hints, navigator surfaces, permissions, screen/window geometry, pointer/hover media queries, native descriptors |
| Rendering | Canvas and OffscreenCanvas, worker readbacks, SVG/images, fonts, WebGL, media codecs, offline audio |
| Storage | Cookies, tab/context isolation, IndexedDB, Cache Storage, service-worker interception |

Capability probes record unavailable hardware-dependent APIs rather than
claiming that hardware was exercised. In particular, a null WebGPU adapter is
not evidence of successful WebGPU rendering.

## Running

```sh
nix develop -c node tests/parity/run.mjs \
  --binary /path/to/cloakium-chromium --output artifacts/parity/result.json
```

The runner starts and cleans up its own reference display. Two iterations run
in opposite mode order to detect order dependence and unstable observations.
Reports include the exact browser path, reference policy and driver patch
manifest. A window manager's theme-dependent borders are not a Chromium bug:
the same browser legitimately has different frame insets with and without
Openbox. These must not be "fixed" by hardcoding desktop pixels in Blink.

`--select environment/` limits a run to one probe family. `--report-only` allows
observed cross-mode differences for investigation; functional failures and
unstable observations still fail.

`--native-defaults` removes Playwright's implicit scrollbar hiding, audio
muting, and pointer/hover `--blink-settings` argument. This separates native
Chromium configuration from automation-adapter choices. The executable's
desktop profile still applies. It does not inject JavaScript or overwrite
page properties.

## Maintenance boundary

Prefer Chromium's own configuration mechanisms to new engine patches.
[`--screen-info`](https://developer.chrome.com/docs/automation-and-testing/headless-screen-config)
configures the actual virtual screen, rather than spoofing `window.screen`.
Blink's existing input settings configure real pointer/hover media-query
behaviour. Explicit caller options and context emulation remain authoritative.

The small Rust launcher applies these defaults only to fingerprint-enabled
headless launches. It preserves explicit screen, Ozone, scale-factor and Blink
settings. All three public executable names use that launcher; the
`chromium-native` flake package remains the underlying source-patched browser.
The launcher uses `exec`, preserving the debugging pipes and Chromium's exit
status, and does not log arguments or add runtime downloads.

The existing source patches retain their strict Nix replay and runtime gates.
The Playwright patch addresses its own implicit scrollbar-hiding argument.
Neither layer should impersonate an operating-system window manager or add
spurious mouse events to reproduce a headed automation artifact.

`npm run test:parity:fullscreen -- --binary /path/to/cloakium-chromium` adds a
private Openbox reference with viewport
emulation disabled. It tests trusted page entry/exit, then separately requests
native window fullscreen with `Browser.setWindowBounds`. Both modes must fill
the real configured 1920×1080 screen and restore their prior window bounds.
The configured automation session can use Chromium's fullscreen-within-tab
policy; its request-only geometry is recorded separately, not misrepresented
as an operating-system window resize.

## Results and diagnostic boundaries

The integrated Linux run covers 42 scenarios in each mode, twice, with and
without Playwright's implicit headless defaults: 336 probe executions.
Both profiles pass with zero functional failures, unstable observations or
contract differences. Headless display environment variables are absent in
every recorded run.

Two explicitly named diagnostics retain physical-window evidence separately:
X11's duplicate pointer-boundary events after window-history changes, and its
pointer-lock cursor-warp startup. The asserted target transitions, trusted
events, requested relative movements, lock/release and application state are
still compared. No arbitrary property exclusions or page getter overrides are
used. This is a tested behavioural contract, not a claim to cover every web API
or reproduce every desktop window manager.

## Acceptance

The regression run must have no failed probes, no unstable observations, and
no unexplained cross-mode differences. Explicit caller emulation and native
screen configuration must remain effective. The ordinary browser, driver,
privacy, and sandbox regression suites remain mandatory.
