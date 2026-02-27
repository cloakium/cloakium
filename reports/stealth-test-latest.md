# Stealth Test Report

**Date:** 2026-02-27 12:54 UTC

## darwin-arm64

**Result:** 20/22 passed in 2.7s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 2.19s |
| `test_no_headless_chrome_ua` | PASS | 0.02s |
| `test_window_chrome_exists` | PASS | 0.00s |
| `test_plugins_present` | PASS | 0.01s |
| `test_languages_present` | PASS | 0.01s |
| `test_cdp_not_detected` | PASS | 0.00s |
| `test_hardware_concurrency_override` | PASS | 0.00s |
| `test_platform_override` | PASS | 0.00s |
| `test_worker_platform_matches_main` | PASS | 0.01s |
| `test_canvas_noise_applied` | PASS | 0.01s |
| `test_audio_context_noise` | PASS | 0.01s |
| `test_client_rect_noise_applied` | PASS | 0.00s |
| `test_cdp_prepare_stack_trace_not_triggered` | FAIL | 0.01s |
| `test_cdp_not_detected_in_worker` | FAIL | 0.01s |
| `test_no_playwright_globals` | PASS | 0.00s |
| `test_chrome_runtime_exists` | PASS | 0.00s |
| `test_webdriver_false_in_iframe` | PASS | 0.01s |
| `test_worker_values_consistent` | PASS | 0.01s |
| `test_webgl_vendor_override` | PASS | 0.02s |
| `test_webgl_renderer_override` | PASS | 0.01s |
| `test_client_hints_platform_consistent` | PASS | 0.03s |
| `test_screen_resolution_not_headless_default` | PASS | 0.20s |

## linux-amd64

**Result:** 20/22 passed in 1.7s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 1.03s |
| `test_no_headless_chrome_ua` | PASS | 0.00s |
| `test_window_chrome_exists` | PASS | 0.00s |
| `test_plugins_present` | PASS | 0.00s |
| `test_languages_present` | PASS | 0.00s |
| `test_cdp_not_detected` | PASS | 0.00s |
| `test_hardware_concurrency_override` | PASS | 0.00s |
| `test_platform_override` | PASS | 0.00s |
| `test_worker_platform_matches_main` | PASS | 0.01s |
| `test_canvas_noise_applied` | PASS | 0.01s |
| `test_audio_context_noise` | PASS | 0.01s |
| `test_client_rect_noise_applied` | PASS | 0.00s |
| `test_cdp_prepare_stack_trace_not_triggered` | PASS | 0.00s |
| `test_cdp_not_detected_in_worker` | PASS | 0.01s |
| `test_no_playwright_globals` | PASS | 0.00s |
| `test_chrome_runtime_exists` | PASS | 0.00s |
| `test_webdriver_false_in_iframe` | PASS | 0.01s |
| `test_worker_values_consistent` | PASS | 0.01s |
| `test_webgl_vendor_override` | FAIL | 0.00s |
| `test_webgl_renderer_override` | FAIL | 0.00s |
| `test_client_hints_platform_consistent` | PASS | 0.01s |
| `test_screen_resolution_not_headless_default` | PASS | 0.11s |

## live-darwin-arm64

**Result:** 3/4 passed in 35.6s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | FAIL | 12.92s |
| `test_browserscan` | PASS | 10.31s |
| `test_fingerprintjs` | PASS | 7.55s |
| `test_recaptcha_v3` | PASS | 4.70s |

## live-linux-amd64

**Result:** 4/4 passed in 30.5s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | PASS | 10.45s |
| `test_browserscan` | PASS | 9.12s |
| `test_fingerprintjs` | PASS | 6.21s |
| `test_recaptcha_v3` | PASS | 4.64s |

**Total: 47/52 passed across 4 platform(s) in 70.5s**
