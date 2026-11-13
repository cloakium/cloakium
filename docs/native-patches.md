# Native patches

Cloakium ships original, MIT-licensed **native** changes to Chromium. There is
no JavaScript `navigator` patching, no injected preload script and no DevTools
override layer: every feature below is compiled into the browser and is off
unless `--fingerprint` is explicitly passed.

The patches live in `patches/chromium/` and are replayed with `patch -p1
--fuzz=0` plus sentinel assertions (`nix/chromium.nix`). The same script backs
`nix build .#chromium-patch-check`, a source-only replay that needs no compile.

## Switches

| Switch | Meaning |
|---|---|
| `--fingerprint=<seed>` | Enables the native privacy features. `<seed>` is a decimal value or any stable string; the same seed + origin gives identical readback noise. |
| `--fingerprint-hardware-concurrency=<n>` | Overrides `navigator.hardwareConcurrency` while fingerprint mode is on. |
| `--fingerprint-device-memory=<n>` | Overrides `navigator.deviceMemory` (GiB) while fingerprint mode is on. |
| `--fingerprint-webgl-profile=<name>` | Explicitly requests a static WebGL unmasked profile. Never selected automatically. |

Without `--fingerprint` every value is Chromium's real host value. The browser
still works normally; the features are inert.

`--fingerprint-*` switches are forwarded to renderer processes only
(`content/browser/renderer_host/render_process_host_impl.cc`). No other switch
is copied.

## What is implemented

### 1. Automation signal (`0003-navigator-webdriver.patch`)

`Navigator::webdriver()` returns `false` when fingerprint mode is enabled.
Automation (CDP, Playwright, `--remote-debugging-pipe`, `--enable-automation`)
still works; only the page-visible signal is suppressed. This is a native
return value, not a JS getter override.

### 2. Headless UA token (`0005-user-agent-headless.patch`)

Chromium normally prepends `Headless` to the UA product when `--headless` is
used, producing `HeadlessChrome/…` in `navigator.userAgent` **and** in the HTTP
`User-Agent` header while `navigator.userAgentData.brands` still says
`Chromium`. In fingerprint mode the token is omitted, so:

* `navigator.userAgent` contains `Chrome/<major>` (Chromium's reduced UA uses
  the `Chrome` product token for web compatibility);
* the HTTP `User-Agent` is byte-identical to `navigator.userAgent`;
* `Sec-CH-UA` matches `navigator.userAgentData.brands` (`Chromium`, not
  `Chrome`; this is Chromium's normal reduced-UA/client-hint split);
* `Sec-CH-UA-Platform` is `"Linux"` and matches
  `navigator.userAgentData.platform` / `navigator.platform`.

The host platform is **not** spoofed. There are no OS, TLS, or
network-stack impersonation flags in this project.

### 3. Canvas readback noise (`0006-canvas-readback-noise.patch`)

`toDataURL()`, `toBlob()`, `OffscreenCanvas.convertToBlob()` and
`getImageData()` (2D and OffscreenCanvas 2D) return a deterministic ±1
per-channel perturbation of the returned pixels.

Properties:

* **Non-cumulative.** `toDataURL`/`toBlob`/`convertToBlob` perturb a private
  copy of the snapshot; `getImageData` perturbs the freshly allocated
  `ImageData`. The canvas backing store is never mutated.
* **No RNG.** The delta is a pure function of `(seed, origin, x, y, channel)`.
  Repeated reads and repeated renders are identical.
* **Subtle.** Only the low bit of R, G and B is changed; alpha is untouched.
* Only 8-bit RGBA/BGRA buffers are perturbed. Floating-point/HDR canvas
  readbacks pass through unchanged (documented limitation).
* Primarily aimed at the `getImageData` and `toDataURL` fingerprinting paths.

### 4. Audio readback noise (`0007-audio-offline-noise.patch`)

`OfflineAudioContext` renders (the standard audio fingerprinting path) get
deterministic, inaudible sample deltas applied **once**, immediately before the
rendered buffer is handed to JavaScript. `getChannelData()` itself is not
patched: repeated reads return exactly the same samples and nothing accumulates.

Real-time `AudioContext` buffers are not modified.

### 5. Hardware hints (`0004-navigator-hardware.patch`)

Optional explicit values for `navigator.hardwareConcurrency` and
`navigator.deviceMemory`. When the switches are absent the real host values are
returned. Values are not derived from the seed and are not origin-scoped.

### 6. WebGL profile masking (`0008-webgl-profile.patch`)

Only when `--fingerprint-webgl-profile=<name>` is passed, the
`WEBGL_debug_renderer_info` unmasked vendor/renderer strings are replaced with a
static, internally coherent Linux profile:

| Profile | `UNMASKED_VENDOR_WEBGL` | `UNMASKED_RENDERER_WEBGL` |
|---|---|---|
| `mesa-intel-uhd630` | `Intel` | `Mesa Intel(R) UHD Graphics 630 (CFL GT2)` |
| `mesa-amd` | `AMD` | `AMD Radeon Graphics (radeonsi, gfx1030, LLVM 18.1.8, DRM 3.57, 6.8.0)` |
| `swiftshader` | `Google Inc. (Google)` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` |

Masked and unmasked `getParameter` paths agree. Unknown profile names leave the
real values in place rather than silently inventing a profile. `VENDOR` and
`RENDERER` keep Chromium's spec-mandated `WebKit` values.

## Origin scoping

Canvas and audio noise use `seed = mix(--fingerprint value, security origin)`:

* the same page origin gets stable noise across navigations and processes;
* different origins (for example `127.0.0.1` and `localhost`) get different
  noise, so the perturbation is not a new cross-site identifier;
* opaque origins (`data:`, sandboxed frames) hash as `null` and therefore share
  one bucket — a documented limitation;
* `navigator.hardwareConcurrency`, `navigator.deviceMemory`, the WebGL profile,
  the UA and `navigator.webdriver` are **not** origin-scoped. These are
  per-browser settings by design.

## What is deliberately not done

* No JS `navigator`/prototype monkey-patching.
* No OS, TLS, DNS, or network-stack impersonation (`--user-agent` overrides are
  not used; no `sec-ch-ua-platform` spoofing to another OS).
* No fake fonts, timezone, locale, or `Intl` changes.
* No claim of defeating all fingerprinting. This raises the cost of common
  canvas/audio/headless/automation checks; it is not a general anonymity
  system.
* **DevTools serialization getters:** not patched natively. The serializer
  lives in `src/v8` (a separate DEPS repository), and the automation surface is
  already handled at the driver layer: the patched Playwright driver avoids
  enabling the Runtime domain, which removes the DevTools-side getter
  serialization exposure without a V8 fork. No native V8 patch is needed.

## Build integration

* `nix/chromium.nix` patches `chromium.browser` and rebuilds the wrapper so it
  points at the patched unwrapped browser **and** its sandbox output. The
  wrapper exposes `bin/cloakium-chromium` as an alias of `bin/chromium`.
* Each patch file is passed through
  `builtins.path { name = baseNameOf (toString patch); }`, so the Chromium
  derivation depends on the patch file contents only — not on the whole flake
  source. Editing README/docs/JS/Rust or other unrelated files does not change
  `.#chromium.passthru.unwrapped.drvPath`; editing a patch does. Verified both
  directions.
* The nixpkgs-embedded Google API key is replaced by `google_api_key=""` in the
  GN flags (`googleApiKey` can be overridden). No NixOS Google key is
  redistributed.
* Chromium's BSD-3-Clause license is preserved in `meta.license`. The patch
  files are original MIT-licensed contributions; source files added inside
  Chromium carry the upstream BSD-3-Clause header.
* Tested platform: `x86_64-linux` (full compile + native fixtures). The same
  expression is exported for `aarch64-linux`, but that output is only
  evaluated, not built or tested, and is not claimed as supported.

## Verifying locally

Cheap strict replay (no compile, ~1.3 GiB source, minutes):

```sh
nix build .#chromium-patch-check -L
```

Full build:

```sh
nix build .#chromium --cores N --max-jobs 1 -L
```

Native regression tests (real browser, local HTTP fixture only):

```sh
CLOAKIUM_BINARY_PATH=$(nix build .#chromium --print-out-paths)/bin/cloakium-chromium \
  node tests/native/smoke.mjs
```

Verified on `x86_64-linux`: Chromium `157.0.8103.50` compiled with these nine
patches, and all 29 native smoke checks passed against the resulting
`bin/cloakium-chromium`.

`tests/native/smoke.mjs` checks seed determinism, non-cumulative readback,
cross-launch reproducibility, origin scoping, HTTP/JS UA + client-hint
coherence, `navigator.webdriver`, hardware/device-memory propagation and the
explicit WebGL profile.
