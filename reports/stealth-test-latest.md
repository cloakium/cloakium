# Stealth Test Report

<<<<<<< Updated upstream
**Date:** 2026-02-27 11:14 UTC

## darwin-arm64

**Result:** 18/21 passed in 20.9s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 3.03s |
| `test_no_headless_chrome_ua` | PASS | 1.07s |
| `test_window_chrome_exists` | PASS | 1.02s |
| `test_plugins_present` | PASS | 1.03s |
| `test_languages_present` | PASS | 0.94s |
| `test_cdp_not_detected` | PASS | 1.05s |
| `test_hardware_concurrency_override` | PASS | 0.93s |
| `test_platform_override` | PASS | 0.88s |
| `test_worker_platform_matches_main` | FAIL | 0.88s |
| `test_canvas_noise_applied` | PASS | 0.87s |
| `test_audio_context_noise` | PASS | 0.97s |
| `test_client_rect_noise_applied` | PASS | 0.87s |
| `test_cdp_prepare_stack_trace_not_triggered` | FAIL | 1.20s |
| `test_no_playwright_globals` | PASS | 0.82s |
| `test_chrome_runtime_exists` | PASS | 0.76s |
| `test_webdriver_false_in_iframe` | PASS | 0.74s |
| `test_worker_values_consistent` | FAIL | 0.78s |
| `test_webgl_vendor_override` | PASS | 0.74s |
| `test_webgl_renderer_override` | PASS | 0.71s |
| `test_client_hints_platform_consistent` | PASS | 0.73s |
| `test_screen_resolution_not_headless_default` | PASS | 0.74s |

## linux-amd64

**Result:** 18/21 passed in 19.3s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 2.24s |
| `test_no_headless_chrome_ua` | PASS | 0.82s |
| `test_window_chrome_exists` | PASS | 0.81s |
| `test_plugins_present` | PASS | 0.82s |
| `test_languages_present` | PASS | 0.79s |
| `test_cdp_not_detected` | PASS | 0.79s |
| `test_hardware_concurrency_override` | PASS | 1.12s |
| `test_platform_override` | PASS | 0.83s |
| `test_worker_platform_matches_main` | PASS | 0.84s |
| `test_canvas_noise_applied` | PASS | 0.82s |
| `test_audio_context_noise` | PASS | 0.83s |
| `test_client_rect_noise_applied` | PASS | 0.84s |
| `test_cdp_prepare_stack_trace_not_triggered` | FAIL | 0.81s |
| `test_no_playwright_globals` | PASS | 0.82s |
| `test_chrome_runtime_exists` | PASS | 0.88s |
| `test_webdriver_false_in_iframe` | PASS | 0.82s |
| `test_worker_values_consistent` | PASS | 0.82s |
| `test_webgl_vendor_override` | FAIL | 0.81s |
| `test_webgl_renderer_override` | FAIL | 0.83s |
| `test_client_hints_platform_consistent` | PASS | 0.84s |
| `test_screen_resolution_not_headless_default` | PASS | 0.82s |

## live-darwin-arm64

**Result:** 5/6 passed in 58.1s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | FAIL | 13.02s |
| `test_bot_incolumitas` | PASS | 15.23s |
| `test_browserscan` | PASS | 9.71s |
| `test_fingerprintjs` | PASS | 6.77s |
| `test_recaptcha_v3` | PASS | 6.18s |
| `test_cloudflare_turnstile` | PASS | 7.12s |

## live-linux-amd64

**Result:** 5/6 passed in 51.7s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | FAIL | 10.48s |
| `test_bot_incolumitas` | PASS | 14.16s |
| `test_browserscan` | PASS | 9.32s |
| `test_fingerprintjs` | PASS | 6.21s |
| `test_recaptcha_v3` | PASS | 4.71s |
| `test_cloudflare_turnstile` | PASS | 6.75s |

**Total: 46/54 passed across 4 platform(s) in 150.0s**
=======
**Date:** 2026-02-27 11:22 UTC

## darwin-arm64

**Result:** 20/21 passed in 27.3s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 3.37s |
| `test_no_headless_chrome_ua` | PASS | 1.23s |
| `test_window_chrome_exists` | PASS | 1.17s |
| `test_plugins_present` | PASS | 1.09s |
| `test_languages_present` | PASS | 1.18s |
| `test_cdp_not_detected` | PASS | 1.39s |
| `test_hardware_concurrency_override` | PASS | 1.35s |
| `test_platform_override` | PASS | 1.50s |
| `test_worker_platform_matches_main` | PASS | 1.28s |
| `test_canvas_noise_applied` | PASS | 1.30s |
| `test_audio_context_noise` | PASS | 1.63s |
| `test_client_rect_noise_applied` | PASS | 1.30s |
| `test_cdp_prepare_stack_trace_not_triggered` | FAIL | 1.30s |
| `test_no_playwright_globals` | PASS | 1.06s |
| `test_chrome_runtime_exists` | PASS | 1.12s |
| `test_webdriver_false_in_iframe` | PASS | 1.07s |
| `test_worker_values_consistent` | PASS | 0.94s |
| `test_webgl_vendor_override` | PASS | 1.00s |
| `test_webgl_renderer_override` | PASS | 0.97s |
| `test_client_hints_platform_consistent` | PASS | 0.99s |
| `test_screen_resolution_not_headless_default` | PASS | 0.89s |

## linux-amd64

**Result:** 18/21 passed in 19.9s

| Test | Status | Time |
|------|--------|------|
| `test_navigator_webdriver_false` | PASS | 1.13s |
| `test_no_headless_chrome_ua` | PASS | 0.90s |
| `test_window_chrome_exists` | PASS | 0.90s |
| `test_plugins_present` | PASS | 0.89s |
| `test_languages_present` | PASS | 0.93s |
| `test_cdp_not_detected` | PASS | 0.88s |
| `test_hardware_concurrency_override` | PASS | 0.90s |
| `test_platform_override` | PASS | 0.90s |
| `test_worker_platform_matches_main` | PASS | 0.91s |
| `test_canvas_noise_applied` | PASS | 0.90s |
| `test_audio_context_noise` | PASS | 0.90s |
| `test_client_rect_noise_applied` | PASS | 0.91s |
| `test_cdp_prepare_stack_trace_not_triggered` | FAIL | 0.90s |
| `test_no_playwright_globals` | PASS | 0.91s |
| `test_chrome_runtime_exists` | PASS | 0.90s |
| `test_webdriver_false_in_iframe` | PASS | 0.91s |
| `test_worker_values_consistent` | PASS | 0.95s |
| `test_webgl_vendor_override` | FAIL | 0.92s |
| `test_webgl_renderer_override` | FAIL | 1.17s |
| `test_client_hints_platform_consistent` | PASS | 0.89s |
| `test_screen_resolution_not_headless_default` | PASS | 0.88s |

## live-darwin-arm64

**Result:** 5/6 passed in 58.5s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | FAIL | 13.23s |
| `test_bot_incolumitas` | PASS | 15.33s |
| `test_browserscan` | PASS | 10.01s |
| `test_fingerprintjs` | PASS | 7.07s |
| `test_recaptcha_v3` | PASS | 5.92s |
| `test_cloudflare_turnstile` | PASS | 6.78s |

## live-linux-amd64

**Result:** 6/6 passed in 53.8s

| Test | Status | Time |
|------|--------|------|
| `test_device_and_browser_info` | PASS | 11.11s |
| `test_bot_incolumitas` | PASS | 14.99s |
| `test_browserscan` | PASS | 9.19s |
| `test_fingerprintjs` | PASS | 6.11s |
| `test_recaptcha_v3` | PASS | 4.88s |
| `test_cloudflare_turnstile` | PASS | 7.44s |

**Total: 49/54 passed across 4 platform(s) in 159.6s**
>>>>>>> Stashed changes
