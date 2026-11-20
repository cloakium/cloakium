# Open browser sources: claims, licensing and coverage boundaries

This page and `tests/audit/catalog/sources.json` record **public source claims**
about candidate browsers. They do not audit a binary, do not measure a
fingerprint, and do not assert that any vendor feature resembles Cloakium.

- Catalog schema: `cloakium.audit.sources/1`
- This file is a **source-claim input**. The parent-owned generated gap catalogue
  is a different document (`cloakium.audit.catalog/1`, built from run reports).
- Retrieval: 2026-11-20, public GitHub, project sites, Nixpkgs and documentation
  only
- Network sources: GitHub MCP (after `get_me`), NixOS MCP, Context7,
  `agent-browser` in a named session. No `curl`, raw HTTP or downloaded binary.
- Nothing from a candidate repository, patch or release is copied into this MIT
  project. Feature claims link to source URLs and pinned commits instead.

## What the catalog is not

- **Not a compatibility claim.** A README statement, a patch filename or a
  browsers-test name is source evidence of intent, not proof that a shipped
  binary behaves that way.
- **Not a stealth-feature list.** Privacy browsers also ship telemetry removal,
  ad blocking, security hardening, proxy configuration, profile policy and
  input tooling. Those axes are recorded separately and must not be collapsed
  into "anti-detection".
- **Not a license opinion.** Each entry records the observed license status and
  the proof URL. A GPL/MPL fork's patch text cannot be copied into an MIT
  codebase; only public behaviour observations and original tests may be
  reimplemented independently.
- **Not patch causality.** Engine version differences (for example Chromium 153
  versus 158) can change observable behaviour without any privacy patch being
  responsible. Version lag is recorded as freshness, never as a feature cause.
- **Not execution.** Every source is `not-executed` or explicitly non-runnable;
  no candidate binary was acquired, installed or launched.

## Candidate matrix

| ID | Kind | Engine | Platforms | Headless | CDP | Playwright | License | Freshness |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ungoogled-chromium` | Chromium patch set | 158.0.8127.36 | Linux, Windows, macOS, Android | inherited, unverified | inherited, unverified | executablePath only, unverified | BSD-3-Clause | current; release 2026-11-19 |
| `cromite` | Chromium fork | 153.0.8010.37 | Android, Linux x86_64, Windows x86_64 | inherited, unverified | inherited, unverified | executablePath only, unverified | GPL-3.0-only (patch headers mixed) | **stale**: last release 2026-09-15, no commits after 2026-09-19 |
| `vanadium` | Chromium fork (Android) | 158.0.8127.42 | Android arm64 only | **not applicable** | Android-only, unverified | not applicable | GPL-2.0-only + BSD-3-Clause, exceptions | current; Android-only |
| `brave` | Chromium fork + product repo | 158.0.8127.42 | Linux, Windows, macOS, Android, iOS | inherited, unverified | inherited, unverified | executablePath only, unverified | MPL-2.0 | current stable; beta v1.102.28 |
| `helium` | Chromium fork | 158.0.8127.36 | Linux x86_64/aarch64, Windows, macOS | inherited, unverified | inherited, unverified | executablePath only, unverified | GPL-3.0-only | current; beta |
| `thorium` | Chromium fork | 158.0.8127.41 | Linux, Windows, macOS, Android, ChromeOS | inherited, unverified | inherited, unverified | executablePath only, unverified | BSD-3-Clause | M158 beta, same day |
| `mullvad-browser` | Firefox/Gecko fork | 153.7.0 | Linux, Windows, macOS | unverified | not Chromium CDP | unsupported (patched Firefox required) | MPL-2.0 | 16.0.2, current for Gecko |
| `librewolf` | Firefox/Gecko fork | 160.0.1 | Linux, Windows, macOS | unverified | not Chromium CDP | unsupported (patched Firefox required) | MPL-2.0 | 160.0.1-1, current for Gecko |

"Headless: inherited, unverified" means the Chromium upstream documents
`--headless` for Chromium-based binaries, but no candidate binary was run and no
candidate-specific headless artifact was observed. It is not a pass.

### Nixpkgs facts (unstable channel, 2026-11-20)

| Attribute | Version | Note |
| --- | --- | --- |
| `chromium` | 158.0.8127.36 | Upstream source build, BSD-3-Clause |
| `ungoogled-chromium` | 157.0.8103.78 | Patch set packaged by nixpkgs; one Chromium major behind the catalog HEAD |
| `brave` | 1.99.57 | MPL-2.0 |
| `librewolf` | 160.0.1-1 | MPL-2.0 |
| `mullvad-browser` | 16.0.2 | MPL-2.0 plus LGPL variants |
| `tor-browser` | 16.0.1 | Listed for the non-Chromium boundary only |
| `cromite` | not packaged | `nix` reports `NOT_FOUND` |
| `vanadium` | not packaged | `nix` reports `NOT_FOUND`; Android/GrapheneOS only |
| `helium` | not packaged | The name resolves to an unrelated Haskell compiler |

The workspace flake pins nixpkgs revision
`d4f25a3e562008648d45bcf2d70bcc7422cad84e`; the versions above are the live
channel values returned by the NixOS MCP at retrieval, so a user's pinned
nixpkgs can differ.

### API facts used by the probes

- Chromium headless is a unified mode selected by `--headless`; since Chromium
  132 the old implementation is a separate `chrome-headless-shell` binary
  (`developer.chrome.com/docs/automation-and-testing/headless`).
- Playwright's `executablePath` docs state that Playwright only works with its
  bundled Chromium, Firefox or WebKit and that a custom build is used at the
  caller's risk (`docs/src/api/params.md`, pinned Playwright commit).
- Playwright's `locale` context option affects `navigator.language`,
  `Accept-Language` and number/date formatting; `timezoneId` changes the
  context timezone. Both are caller-owned in this suite.
- `Permissions.query()` rejects an unsupported descriptor name with `TypeError`
  and returns a `PermissionStatus` with `state`, `name` and change events
  (MDN, `Permissions/query`, retrieved 2026-11-20).
- WebGPU compute uses `createComputePipeline`, a storage buffer, a command
  encoder and `mapAsync(GPUMapMode.READ)` for readback (W3C WebGPU explainer and
  buffer-operations design notes).

### Vendor claims versus verified Cloakium requirements

Cloakium's own repository is the source of its requirements, not a vendor page:

| Requirement (Cloakium docs) | Not equivalent to a vendor claim |
| --- | --- |
| Coherent contexts and persistent identities (`README.md`, `docs/architecture.md`) | Brave farbling deliberately randomizes per session/site; ungoogled rect/canvas noise is opt-in per document; Cromite can randomize timezone |
| Caller-owned locale/timezone (`README.md` example, `docs/api.md`) | A vendor default or randomized locale is not the caller's explicit value |
| Desktop headless with a headed control (`docs/headless-parity.md`) | Vanadium is Android-only; Android absence is a platform boundary |
| Playwright public API and patched Playwright driver (`README.md`) | Gecko forks require Playwright's own patched Firefox and do not speak Chromium CDP |
| No JavaScript injection or page-property overriding (`docs/headless-parity.md` maintenance boundary) | Marketing "fingerprint protection" can be a JS shim; it is not comparable to a native patch |
| Ad blocking, telemetry removal, DRM policy and OS hardening are separate axes | Brave Shields, LibreWolf uBlock, Vanadium MTE/CFI and Cromite ad blocking are not joint-stealth claims |

## Per-source boundaries

### ungoogled-chromium

- Repository is a patch set and build configuration, not a full Chromium source
  archive. The engine tarball is fetched at build time.
- Several privacy behaviours are **opt-in switches** (`docs/flags.md`): canvas
  image-data noise, canvas `measureText` noise and client-rect noise.
- Default-off flags mean an audit must read the selected launcher's arguments;
  a browser that implements the patch but never enables it is not evidence of
  active noise.
- Safe Browsing is deliberately disabled by the project. That is a tradeoff to
  record, not automatically a Cloakium requirement.

### cromite

- Feature document mixes Android, Windows and desktop behaviour; each line is
  tagged only where the project tagged it.
- It disables WebGL, WebGPU, WebRTC, Client Hints, Speech Synthesis and several
  device APIs by default. That is API removal, not persona coherence.
- Timezone may be custom or randomized. A randomized zone is an intentional
  incoherence strategy and must not be compared to a fixed-persona run for
  equality.
- Last release is five Chromium majors behind and the default branch had no
  commits for roughly two months at retrieval.

### vanadium

- `target_os = "android"`, arm64 only, and it depends on GrapheneOS OS
  hardening. There is no Linux desktop build.
- Android-only absence (desktop headless, Linux sandbox, CDP over a desktop
  pipe) is a **platform boundary**, not a missing vendor feature.
- JIT-disabled-by-default, MTE, CFI and seccomp dynamic-code restrictions are
  security hardening; they are not anti-fingerprinting behaviour.

### brave

- `brave-browser` is the release/product repo; `brave-core` holds engine source.
- Farble values are seeded per session, per eTLD+1 site and per storage area.
  Repeated visits and different sites are expected to differ. Any equality
  assertion across sessions is invalid for Brave.
- Browsers-test filenames prove test coverage intent for canvas, WebGL, WebGPU,
  Web Audio, screen and navigator surfaces. They do not prove exact outputs.

### helium

- Fork of ungoogled-chromium; carries canvas and audio noise patches, plus the
  Bromite client-rect/measureText patch and ungoogled WebGL-renderer flag.
- Product page marketing ("tampers with fingerprinting", "no background
  requests") is recorded as a claim only. Named patches are the source evidence.
- README labels the product beta.

### thorium

- General-purpose performance/UI fork. Its documented privacy work is GPC,
  Privacy Sandbox defaults, DoH header reduction, codecs and extension policy.
- It is **not** an anti-fingerprint reference. Do not infer noise or persona
  behaviour from performance or media features.
- The M158 release was beta and listed no assets at retrieval; CPU-specific
  SIMD builds can fail before startup on unsupported hosts.

### mullvad-browser and librewolf (non-Chromium boundary)

- Gecko-based. They do not speak Chromium CDP and cannot be launched by
  Playwright's Chromium support. Playwright's documented Firefox support uses
  its own patched build, not an arbitrary Firefox fork.
- They are included only because they are useful privacy references: a uniform
  profile / hardened-preference strategy is conceptually different from a
  coherent Chromium persona.
- Tor Browser itself is not catalogued: it is a network-anonymity product, not a
  Chromium drop-in, and its threat model would dominate the comparison.

## Claims by axis (not one "stealth" bucket)

| Axis | Source claims to audit separately |
| --- | --- |
| Fingerprinting deception / coherence | ungoogled rect/canvas noise flags, Cromite canvas/rect/audio/timezone/language overrides, Helium canvas/audio noise, Brave per-site farbling, Vanadium WebGPU-off and battery stub, LibreWolf hardened preferences |
| Network privacy | Cromite cookie partitioning and TLS-resumption removal, Vanadium WebRTC policy, Thorium DoH header reduction, Cloakium proxy and GeoIP options (own repository) |
| Security hardening | Vanadium MTE, CFI, JIT-off, DrumBrake, seccomp dynamic-code restriction |
| Ad and tracker blocking | Brave Shields, Helium uBlock fork, Vanadium EasyList engine, Thorium uBlock preinstall/MV2, LibreWolf bundled uBlock |
| Telemetry and experiments | ungoogled service removal, Vanadium variations-off, Thorium field-trial defaults, LibreWolf no telemetry, Helium background-request claim |
| Profiles and UI policy | Cromite always-incognito and proxy page, Helium persistent pinned tabs, Thorium UI/extension controls, Cloakium persistent profiles |
| Input | Cromite keyboard-layout mitigation, Cloakium optional Playwright-only pacing |

Only the first row is a candidate for a fingerprint-coherence audit. The other
rows are recorded so a later report does not credit ad blocking or OS hardening
as stealth behaviour.

## Deduplication against existing coverage

Existing suites already cover a large surface. New probes must add behaviour,
not counter inflation.

| Existing area | Already covered | What is still missing |
| --- | --- | --- |
| Parity (42 scenarios) | Input, windows/frames, environment, rendering, storage, headed/headless differential | No CSSOM rect precision, no cross-realm locale/Date coherence, no WebGPU compute readback, no readPixels error semantics |
| `tests/audit/fingerprint` | Navigator, screen, canvas/OffscreenCanvas, SVG, text metrics, WebGL params/clear/loss, WebGPU adapter request, offline audio determinism, media devices, speech, WebAuthn, DRM, origin scope | Adapter request is not compute; audio determinism is not signal calibration; WebGL status/error semantics and contextless handling are absent |
| `tests/audit/network` | Cookies/CHIPS, DNS/DoH, proxy paths, SOCKS5, TLS/HTTP2, HTTP/3, WebRTC/STUN, timing, profile export, popup/shadow DOM | No page-scope background-egress inventory with an explicit "absence not provable here" verdict |
| `tests/audit/request-paths` | Request taxonomy and proxy path attribution | Not a general egress inventory |
| `tests/audit/profile-lifecycle` | Persistent profiles, seeds, extension MV3, storage state | Not browser-internal background traffic |
| `tests/audit/browser-contracts` | Native descriptors, CDP console, trusted input metadata, popup/navigation/shadow-DOM policy, realtime audio clock | Input physics invariants (wheel deltas, coordinate echo, ordering) and an optional humanizer annotation are not covered |

The eight additional probes in `tests/audit/additional/` therefore target only
these gaps. Two of them deepen an existing area (input and audio) rather than
claiming a new surface.

## Feature-claim gaps and broadening IDs

These IDs are source-claim vocabulary. They are intentionally separate from
probe IDs; a claim can exist without a probe, and a probe can exist without a
vendor claim.

| Claim ID | Source(s) | Why current probing misses it |
| --- | --- | --- |
| `antifingerprint.client-rects-noise-flag` / `.client-rects-and-measuretext` | ungoogled-chromium, helium, cromite | No rect/measureText precision or transform-coherence probe |
| `antifingerprint.timezone-custom-or-random`, `antifingerprint.navigator-language-override` | cromite | Locale/timezone are only checked as navigator values; no realm coherence or DST/header comparison |
| `antifingerprint.per-site-session-farbling` | brave | Existing probes assume a stable persona; farbling is intentionally unstable across sessions/sites |
| `antifingerprint.webgpu-disabled`, `.webgpu-farbling` | cromite, vanadium, brave | Current WebGPU probe only requests an adapter; no compute/readback or error-scope evidence |
| `antifingerprint.audio-mitigation`, `.audio-noise` | cromite, helium | Offline audio probe checks determinism and peak, not calibrated gain response or silence differential |
| `input.keyboard-layout-api-mitigation` | cromite | No event-physics or keyboard-layout observation |
| `privacy.no-background-requests` (claim) | helium | Page-level instrumentation cannot prove browser-process egress absence |
| `security.jit-disabled-default`, `.mte`, `.cfi` | vanadium | Security hardening is not fingerprint stealth; cannot be credited on Linux |
| `adblock.*`, `privacy.telemetry-disabled`, `privacy.drm-disabled` | brave, helium, thorium, librewolf, vanadium | Separate privacy/security axes; no stealth inference |

### New probe families (owned here)

| Family ID | Probe ID | Public API surface |
| --- | --- | --- |
| `geometry` | `geometry/dom-rect-invariants` | `DOMRect`, `getBoundingClientRect`, `getClientRects`, CSS transforms, subpixel repeats |
| `locale` | `locale/realm-coherence` | `navigator.languages`, `Intl.DateTimeFormat`, `Date`, dedicated/shared/service workers, `Accept-Language` request header |
| `compute` | `compute/webgpu-readback` | `navigator.gpu`, compute pipeline, storage buffer, `mapAsync` readback, error scopes |
| `render` | `render/webgl-readpixel-status` | `readPixels` error/status semantics, `checkFramebufferStatus`, context-loss state |
| `audio` | `audio/signal-calibration` | `OfflineAudioContext` gain response, silence differential, determinism |
| `input` | `input/event-physics` | Raw CDP mouse/key/wheel events, trusted flags, coordinate/delta echo, optional humanizer annotation |
| `egress` | `egress/request-inventory` | Playwright request events for page-scope egress; explicit unknown for OS-level absence |
| `permissions` | `permissions/descriptor-semantics` | `navigator.permissions.query`, `PermissionStatus` stability, grant/clear transitions, no capture |

## Unknowns and the method that would resolve them

- **Background egress outside page instrumentation**: needs OS-level capture
  (socket/DNS/packet) or browser-process logging. Page request events cannot
  prove absence. The probe marks that check `inconclusive` and the probe
  coverage `partial`.
- **Hardware absence**: a missing adapter, capture device or sensor is recorded
  as `passed: null`, never as a pass. Software adapters are acceptable for
  WebGPU but are labelled fallback, not physical-GPU evidence.
- **Farbling/session randomization**: cross-run equality is only meaningful for
  a fixed-persona build. Brave-style farbling requires a different comparison
  strategy (distribution across sessions/sites, not equality).
- **Android-only and Gecko-only sources**: cannot be audited with this Linux
  Chromium/Playwright harness; record the platform boundary rather than a gap.

## Additional probe suite

Eight original probes implement only the gaps above. They use public Web APIs,
create their own fixture DOM, and never inject scripts, patch native properties
or read vendor tables.

| Probe | Shape of the assertion |
| --- | --- |
| `geometry/dom-rect-invariants` | DOMRect arithmetic, transforms, subpixel width, inline rect count/union, five repeated reads, same-origin iframe agreement |
| `locale/realm-coherence` | `navigator.languages`, Intl locale/timezone, DST-season `Date` offsets and `longOffset` agreement, dedicated/shared/service workers, `Accept-Language` |
| `compute/webgpu-readback` | Adapter/device, 64-wide compute dispatch, exact storage-buffer readback, validation-error scope |
| `render/webgl-readpixel-status` | Exact clear bytes, framebuffer status, invalid `readPixels` errors and untouched buffers, forced context loss/restore |
| `audio/signal-calibration` | Gain-response ratio between declared gains, silence differential, repeat determinism, frequency sensitivity |
| `input/event-physics` | Raw CDP pointer/key/wheel mechanics, trust, coordinate and delta echo, ordering, optional humanizer annotation |
| `egress/request-inventory` | Page-scope request inventory with controlled fetch/beacon/image egress and an explicit unknown for browser-process absence |
| `permissions/descriptor-semantics` | Descriptor state stability, `PermissionStatus` shape, TypeError for an unknown descriptor, context grant/clear, no capture call |

### Running the local smoke

The probes are not a standalone audit runner. The parent-owned runner supplies
the page, context, origin, cross-origin alias, optional config and deadline. For
local verification only:

```sh
CLOAKIUM_AUDIT_BINARY=/path/to/chromium \
  node tests/audit/additional/tests/smoke.mjs
```

`CLOAKIUM_AUDIT_ONLY='locale|webgl'` filters by probe id,
`CLOAKIUM_AUDIT_VERBOSE=1` includes observations and check rows, and
`CLOAKIUM_AUDIT_ARGS='--enable-unsafe-webgpu'` forwards extra browser arguments. Unit and catalog
tests:

```sh
node --test tests/audit/additional/tests/*.test.mjs
```

Smoke observations on 2026-11-20 with the repository Chromium 157.0.8103.50
build, Node 26 and the patched `playwright-core` 1.65.1: eight probes executed,
zero harness errors, about nine seconds total. The same eight probes also ran in
a private Xvfb headed control (`CLOAKIUM_AUDIT_HEADED=1`) with the same outcomes. `geometry`, `audio`, `input` and
`permissions` were fully evaluable. `compute` reported no adapter by default and
therefore seven null checks; with `--enable-unsafe-webgpu` a SwiftShader adapter
resolved and the compute/readback probe passed all eight checks with the exact
`[2,4,6,8,10,12,14,16]` output. That is software-adapter evidence, not a
physical-GPU claim. `render` could not obtain a restored context on this host, so
the restore check is unavailable rather than failed. `egress` kept its
browser-process absence check unknown. `locale` measured one real mismatch:
`SharedWorker` resolved `en-GB` while the window, dedicated worker and service
worker resolved `en-US`; unpatched Chromium can take the shared-worker language
from the browser process rather than the context locale.

These are harness observations, not candidate findings. A candidate audit must
record its own values and modes. Every probe is mode-agnostic: it uses the
supplied `page`/`context` and never reads a display variable, so the parent
runner can execute it in headless and headed control modes with the same
descriptor.

Result statuses follow the parent runner contract: `pass` and `fail` carry a
boolean verdict; `unavailable` (hardware or API absent), `inconclusive`
(coverage unknown, for example browser-process egress) and
`unsupported-by-target` carry `passed: null`. `passed: null` is never a pass.
The probe also reports a derived `coverage` of `full`, `partial` or `unknown`.

The optional humanizer annotation is `config.humanizer.install(page)`. When
present, the input probe records target hit and pointer-step count but never
asserts a human timing distribution.

## Refresh procedure

1. Retrieve with the same source ladder: GitHub MCP (`get_me` first, batches of
   5-10), NixOS MCP for package/option facts, Context7 for library API,
   `agent-browser` for other pages.
2. Record UTC retrieval time, full 40-character commit SHA, release tag and
   publication time, and the license proof URL. Prefer a pinned commit over a
   moving branch; a release tag is not a commit.
3. Keep license status separate from code availability: GPL/MPL/source-available
   are not MIT. Never copy candidate source, tables or binaries into this repo.
4. Compare engine major with the Chromium and Playwright reference builds and
   record lag as freshness, never as patch causality.
5. Re-run the catalog structure checks and keep the previous catalog beside the
   new one so changes diff by source ID, not file order.
