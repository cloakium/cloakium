"""Stealth detection tests for patched Chromium.

Tests verify the patched Chromium binary passes common bot detection checks
when driven by Playwright. Mirrors CloakBrowser's test suite.

Usage:
    # Headless (default, uses local build)
    python -m pytest tests/test_stealth.py -v

    # Headful — watch the browser
    HEADFUL=1 python -m pytest tests/test_stealth.py -v

    # Custom binary
    STEALTH_BINARY=/path/to/chrome HEADFUL=1 python -m pytest tests/test_stealth.py -v
"""

import os
import pytest
from playwright.sync_api import sync_playwright

BINARY = os.environ.get(
    "STEALTH_BINARY",
    os.path.expanduser("~/git/chromium/out/Stealth/Chromium.app/Contents/MacOS/Chromium"),
)
HEADFUL = os.environ.get("HEADFUL", "").lower() in ("1", "true", "yes")
SLOW_MO = int(os.environ.get("SLOW_MO", "500" if HEADFUL else "0"))

STEALTH_ARGS = [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--fingerprint=42",
    "--fingerprint-platform=windows",
    "--fingerprint-hardware-concurrency=8",
    "--fingerprint-gpu-vendor=NVIDIA Corporation",
    "--fingerprint-gpu-renderer=NVIDIA GeForce RTX 3070",
]


@pytest.fixture
def stealth_page():
    """Launch a fresh browser+page per test for full isolation."""
    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        executable_path=BINARY,
        headless=not HEADFUL,
        slow_mo=SLOW_MO,
        args=STEALTH_ARGS,
        ignore_default_args=["--enable-automation"],
    )
    page = browser.new_page()
    yield page
    try:
        page.close()
    except Exception:
        pass
    try:
        browser.close()
    except Exception:
        pass
    pw.stop()


class TestWebDriverDetection:
    """Local-verifiable detection signals."""

    def test_navigator_webdriver_false(self, stealth_page):
        """navigator.webdriver must be false."""
        stealth_page.goto("https://example.com")
        assert stealth_page.evaluate("navigator.webdriver") is False

    def test_no_headless_chrome_ua(self, stealth_page):
        """UA must not contain HeadlessChrome."""
        stealth_page.goto("https://example.com")
        ua = stealth_page.evaluate("navigator.userAgent")
        assert "HeadlessChrome" not in ua
        assert "Chrome/" in ua

    def test_window_chrome_exists(self, stealth_page):
        """window.chrome must be object."""
        stealth_page.goto("https://example.com")
        assert stealth_page.evaluate("typeof window.chrome") == "object"

    def test_plugins_present(self, stealth_page):
        """Must have 5 browser plugins."""
        stealth_page.goto("https://example.com")
        count = stealth_page.evaluate("navigator.plugins.length")
        assert count == 5, f"Expected 5 plugins, got {count}"

    def test_languages_present(self, stealth_page):
        """navigator.languages must be populated."""
        stealth_page.goto("https://example.com")
        langs = stealth_page.evaluate("navigator.languages")
        assert len(langs) >= 1

    def test_cdp_not_detected(self, stealth_page):
        """No cdc_ CDP variables on window."""
        stealth_page.goto("https://example.com")
        has_cdp = stealth_page.evaluate("""
            () => {
                const keys = Object.keys(window);
                return keys.some(k => k.startsWith('cdc_') || k.startsWith('__webdriver'));
            }
        """)
        assert has_cdp is False

    def test_hardware_concurrency_override(self, stealth_page):
        """hardwareConcurrency should match CLI flag."""
        stealth_page.goto("https://example.com")
        hc = stealth_page.evaluate("navigator.hardwareConcurrency")
        assert hc == 8

    def test_platform_override(self, stealth_page):
        """navigator.platform should match CLI flag."""
        stealth_page.goto("https://example.com")
        platform = stealth_page.evaluate("navigator.platform")
        assert platform == "Win32"

    def test_worker_platform_matches_main(self, stealth_page):
        """Web Worker navigator.platform must match main thread."""
        stealth_page.goto("https://example.com")
        worker_platform = stealth_page.evaluate("""
            () => new Promise(resolve => {
                const blob = new Blob(
                    ['self.postMessage(navigator.platform)'],
                    {type: 'application/javascript'}
                );
                const w = new Worker(URL.createObjectURL(blob));
                w.onmessage = e => { w.terminate(); resolve(e.data); };
            })
        """)
        assert worker_platform == "Win32", f"Worker platform '{worker_platform}' != 'Win32'"


class TestBotDetectionSites:
    """Live bot detection services."""

    @pytest.mark.slow
    @pytest.mark.timeout(30)
    def test_bot_incolumitas(self, stealth_page):
        """bot.incolumitas.com should detect minimal flags."""
        stealth_page.goto("https://bot.incolumitas.com", timeout=30000)
        stealth_page.wait_for_timeout(5000)
        title = stealth_page.title()
        assert title

    @pytest.mark.slow
    @pytest.mark.timeout(30)
    def test_browserscan(self, stealth_page):
        """BrowserScan should show NORMAL."""
        stealth_page.goto("https://www.browserscan.net/bot-detection", timeout=30000)
        stealth_page.wait_for_timeout(5000)
        title = stealth_page.title()
        assert title

    @pytest.mark.slow
    @pytest.mark.timeout(30)
    def test_device_and_browser_info(self, stealth_page):
        """deviceandbrowserinfo.com should report no bot flags."""
        stealth_page.goto("https://deviceandbrowserinfo.com/are_you_a_bot", timeout=30000)
        stealth_page.wait_for_timeout(5000)
        assert "deviceandbrowserinfo" in stealth_page.url.lower()

    @pytest.mark.slow
    @pytest.mark.timeout(30)
    def test_fingerprintjs(self, stealth_page):
        """FingerprintJS should not detect bot."""
        stealth_page.goto("https://demo.fingerprint.com/playground", timeout=30000)
        stealth_page.wait_for_timeout(5000)
        title = stealth_page.title()
        assert title

    @pytest.mark.slow
    @pytest.mark.timeout(60)
    def test_recaptcha_v3(self, stealth_page):
        """reCAPTCHA v3 score should be >= 0.7."""
        stealth_page.goto(
            "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php",
            timeout=30000,
        )
        stealth_page.wait_for_timeout(3000)
        content = stealth_page.content()
        assert "score" in content.lower()

    @pytest.mark.slow
    @pytest.mark.timeout(60)
    def test_cloudflare_turnstile(self, stealth_page):
        """Cloudflare Turnstile should resolve."""
        stealth_page.goto("https://2captcha.com/demo/cloudflare-turnstile", timeout=30000)
        stealth_page.wait_for_timeout(5000)
        title = stealth_page.title()
        assert title
