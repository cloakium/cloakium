# Cloakium

Stealth Chromium builds that evade common bot detection. Ships as a drop-in `chrome` binary with CLI flags for fingerprint control — no browser extensions, no JS injection, no runtime patches.

[![Build + Release](https://github.com/cloakium/cloakium/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/cloakium/cloakium/actions/workflows/build-and-release.yml)
[![Stealth Tests](https://github.com/cloakium/cloakium/actions/workflows/stealth-tests.yml/badge.svg)](https://github.com/cloakium/cloakium/actions/workflows/stealth-tests.yml)

## Platforms

| Platform | Asset | Status |
|----------|-------|--------|
| Linux x86_64 | `cloakium-linux-amd64.tar.zst` | Available |
| macOS ARM64 | `cloakium-darwin-arm64.zip` | Available |

## Download

```bash
# Latest release, auto-detect platform
python3 scripts/download.py

# Specific version
python3 scripts/download.py --version 136.0.7103.113

# Custom destination
python3 scripts/download.py --dest /opt/cloakium
```

Or download manually from [Releases](https://github.com/cloakium/cloakium/releases/latest).

## Usage

```bash
# Basic stealth launch
./chrome --fingerprint=42

# Full fingerprint override
./chrome \
  --fingerprint=42 \
  --fingerprint-platform=windows \
  --fingerprint-hardware-concurrency=8 \
  --fingerprint-gpu-vendor="NVIDIA Corporation" \
  --fingerprint-gpu-renderer="NVIDIA GeForce RTX 3070"
```

### With Playwright (Python)

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        executable_path="/path/to/chrome",
        headless=True,
        args=[
            "--fingerprint=42",
            "--fingerprint-platform=windows",
            "--fingerprint-hardware-concurrency=8",
        ],
        ignore_default_args=["--enable-automation"],
    )
    page = browser.new_page()
    page.goto("https://example.com")
```

## CLI Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--fingerprint=N` | Seed for canvas/audio/rect noise | `--fingerprint=42` |
| `--fingerprint-platform=P` | Override `navigator.platform` (`windows`/`macos`/`linux` or literal) | `--fingerprint-platform=windows` |
| `--fingerprint-hardware-concurrency=N` | Override `navigator.hardwareConcurrency` | `--fingerprint-hardware-concurrency=8` |
| `--fingerprint-gpu-vendor=S` | Override WebGL unmasked vendor | `--fingerprint-gpu-vendor="NVIDIA Corporation"` |
| `--fingerprint-gpu-renderer=S` | Override WebGL unmasked renderer | `--fingerprint-gpu-renderer="NVIDIA GeForce RTX 3070"` |

## Patches

13 patches applied at compile time to the Chromium source:

| # | Patch | What it does |
|---|-------|-------------|
| 01 | `cli-switches` | Register `--fingerprint*` CLI flags in content switches |
| 02 | `navigator-webdriver-platform` | `navigator.webdriver` returns `false`; platform override via flag (main thread + workers) |
| 03 | `remove-headless-ua` | Strip "HeadlessChrome" from User-Agent string |
| 04 | `remove-cdp-cdc-vars` | Remove `cdc_` CDP detection variables from `window` |
| 05 | `hardware-concurrency-override` | `navigator.hardwareConcurrency` respects CLI flag |
| 06 | `webgl-gpu-spoof` | WebGL `UNMASKED_VENDOR`/`RENDERER` return CLI values |
| 07 | `canvas-noise` | Per-seed pixel noise on `getImageData()` |
| 08 | `audio-noise` | Per-seed frequency noise on `getFloatFrequencyData()` |
| 09 | `client-rect-noise` | Per-seed sub-pixel noise on `getBoundingClientRect()` |
| 10 | `window-chrome-inject` | `window.chrome` object exists in headless mode |
| 11 | `plugins-always-present` | Reports 5 standard plugins in headless mode |
| 12 | `suppress-automation-infobar` | Suppresses "Chrome is being controlled" infobar |
| 14 | `propagate-switches-to-renderer` | Forwards `--fingerprint*` switches to renderer processes |

## How it works

Cloakium tracks Chrome Stable via [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/). When a new stable release appears, CI automatically:

1. Syncs the upstream Chromium source at that tag
2. Applies all stealth patches (with version-independent fallback injection)
3. Builds release binaries for each platform
4. Publishes to GitHub Releases
5. Runs stealth detection tests against the build

## Test Report

See the latest [stealth test results](reports/stealth-test-latest.md).

## Building from source

The `patches/` directory contains all stealth modifications as standard patch files. To build yourself:

```bash
# 1. Set up Chromium build environment (depot_tools, gclient sync)
# 2. Apply patches
cd /path/to/chromium/src
for p in /path/to/cloakium/patches/*.patch; do
  patch -p1 < "$p"
done
# 3. Build
gn gen out/Cloakium --args='is_debug=false is_official_build=true symbol_level=0'
autoninja -C out/Cloakium chrome
```

## License

The patches in this repository are provided as-is. Chromium itself is licensed under the [BSD 3-Clause License](https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
