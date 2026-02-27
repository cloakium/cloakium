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
import json
import platform
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
] + os.environ.get("EXTRA_STEALTH_ARGS", "").split()

# OS-appropriate args for live site tests — no cross-OS platform spoofing.
# Detection sites flag mismatches between UA (reflects real OS) and
# navigator.platform / Client Hints (overridden by --fingerprint-platform).
_OS_PLATFORM = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(
    platform.system(), "linux"
)
LIVE_ARGS = [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--fingerprint=42",
    f"--fingerprint-platform={_OS_PLATFORM}",
    "--fingerprint-hardware-concurrency=8",
    "--fingerprint-gpu-vendor=NVIDIA Corporation",
    "--fingerprint-gpu-renderer=NVIDIA GeForce RTX 3070",
] + os.environ.get("EXTRA_STEALTH_ARGS", "").split()


@pytest.fixture(scope="class")
def stealth_page():
    """Single browser+page shared across all tests in a class."""
    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        executable_path=BINARY,
        headless=not HEADFUL,
        slow_mo=SLOW_MO,
        args=STEALTH_ARGS,
        ignore_default_args=["--enable-automation"],
    )
    page = browser.new_page()
    page.goto("https://example.com")
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


@pytest.fixture
def live_page():
    """Fresh browser+page per test for live site tests."""
    pw = sync_playwright().start()
    browser = pw.chromium.launch(
        executable_path=BINARY,
        headless=not HEADFUL,
        slow_mo=SLOW_MO,
        args=LIVE_ARGS,
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
        assert stealth_page.evaluate("navigator.webdriver") is False

    def test_no_headless_chrome_ua(self, stealth_page):
        """UA must not contain HeadlessChrome."""
        ua = stealth_page.evaluate("navigator.userAgent")
        assert "HeadlessChrome" not in ua
        assert "Chrome/" in ua

    def test_window_chrome_exists(self, stealth_page):
        """window.chrome must be object."""
        assert stealth_page.evaluate("typeof window.chrome") == "object"

    def test_plugins_present(self, stealth_page):
        """Must have 5 browser plugins."""
        count = stealth_page.evaluate("navigator.plugins.length")
        assert count == 5, f"Expected 5 plugins, got {count}"

    def test_languages_present(self, stealth_page):
        """navigator.languages must be populated."""
        langs = stealth_page.evaluate("navigator.languages")
        assert len(langs) >= 1

    def test_cdp_not_detected(self, stealth_page):
        """No cdc_ CDP variables on window."""
        has_cdp = stealth_page.evaluate("""
            () => {
                const keys = Object.keys(window);
                return keys.some(k => k.startsWith('cdc_') || k.startsWith('__webdriver'));
            }
        """)
        assert has_cdp is False

    def test_hardware_concurrency_override(self, stealth_page):
        """hardwareConcurrency should match CLI flag."""
        hc = stealth_page.evaluate("navigator.hardwareConcurrency")
        assert hc == 8

    def test_platform_override(self, stealth_page):
        """navigator.platform should match CLI flag."""
        platform = stealth_page.evaluate("navigator.platform")
        assert platform == "Win32"

    def test_worker_platform_matches_main(self, stealth_page):
        """Web Worker navigator.platform must match main thread."""
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

    # --- Canvas noise verification ---

    def test_canvas_noise_applied(self, stealth_page):
        """Canvas getImageData should have noise injected (not exact fill color)."""
        result = stealth_page.evaluate("""
            () => {
                const c = document.createElement('canvas');
                c.width = 200; c.height = 50;
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#ff0000';
                ctx.fillRect(0, 0, 200, 50);
                const d = ctx.getImageData(0, 0, 200, 50).data;
                let diffCount = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i] !== 255 || d[i+1] !== 0 || d[i+2] !== 0) diffCount++;
                }
                // Call again to verify determinism
                const d2 = ctx.getImageData(0, 0, 200, 50).data;
                let same = true;
                for (let i = 0; i < d.length; i++) {
                    if (d[i] !== d2[i]) { same = false; break; }
                }
                return { diffCount, deterministic: same };
            }
        """)
        assert result["diffCount"] > 0, "Canvas noise not applied — all pixels match exact fill"
        assert result["deterministic"], "Canvas noise not deterministic across reads"

    # --- Audio context noise ---

    def test_audio_context_noise(self, stealth_page):
        """OfflineAudioContext should produce non-trivial output (noise applied)."""
        result = stealth_page.evaluate("""
            () => new Promise(resolve => {
                const ctx = new OfflineAudioContext(1, 44100, 44100);
                const osc = ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(10000, ctx.currentTime);
                const comp = ctx.createDynamicsCompressor();
                osc.connect(comp);
                comp.connect(ctx.destination);
                osc.start(0);
                ctx.startRendering().then(buf => {
                    const data = buf.getChannelData(0);
                    let nonZero = 0;
                    for (let i = 0; i < data.length; i++) {
                        if (data[i] !== 0) nonZero++;
                    }
                    resolve({ nonZero, length: data.length });
                });
            })
        """)
        assert result["nonZero"] > 0, "Audio context produced all zeros"

    # --- Client rect noise ---

    def test_client_rect_noise_applied(self, stealth_page):
        """getBoundingClientRect should have sub-pixel noise."""
        result = stealth_page.evaluate("""
            () => {
                const div = document.createElement('div');
                div.style.cssText = 'position:absolute;left:100px;top:100px;width:200px;height:50px;';
                document.body.appendChild(div);
                const r = div.getBoundingClientRect();
                const hasFraction = v => v !== Math.round(v);
                const noisy = hasFraction(r.x) || hasFraction(r.y) ||
                              hasFraction(r.width) || hasFraction(r.height);
                // Determinism check
                const r2 = div.getBoundingClientRect();
                const same = r.x === r2.x && r.y === r2.y &&
                             r.width === r2.width && r.height === r2.height;
                document.body.removeChild(div);
                return { noisy, deterministic: same };
            }
        """)
        assert result["noisy"], "ClientRect has no sub-pixel noise"
        assert result["deterministic"], "ClientRect noise not deterministic"

    # --- CDP prepareStackTrace detection ---

    def test_cdp_prepare_stack_trace_not_triggered(self, stealth_page):
        """console.log(Error) must not trigger user prepareStackTrace via CDP.

        Detection sites set a PST trap then console.log an Error. CDP serializes
        the Error for the devtools frontend, reading .stack — which normally
        triggers FormatStackTrace -> user PST. Our patch skips user PST when
        the inspector is active.
        """
        triggered = stealth_page.evaluate("""
            () => {
                let called = false;
                Error.prepareStackTrace = function() { called = true; return ''; };
                console.log(new Error('cdp-probe'));
                const result = called;
                delete Error.prepareStackTrace;
                return result;
            }
        """
        )
        assert triggered is False, "Error.prepareStackTrace triggered by console.log (CDP leak)"

    def test_cdp_not_detected_in_worker(self, stealth_page):
        """Same PST trap inside a Web Worker must not be triggered."""
        triggered = stealth_page.evaluate("""
            () => new Promise((resolve, reject) => {
                const code = `
                    let called = false;
                    Error.prepareStackTrace = function() { called = true; return ''; };
                    console.log(new Error('worker-cdp-probe'));
                    postMessage(called);
                `;
                const blob = new Blob([code], {type: 'application/javascript'});
                const w = new Worker(URL.createObjectURL(blob));
                w.onmessage = e => { w.terminate(); resolve(e.data); };
                w.onerror = e => { w.terminate(); reject(e.message); };
                setTimeout(() => { w.terminate(); resolve('timeout'); }, 3000);
            })
        """
        )
        assert triggered is False, "PST triggered in Worker via console.log (CDP leak)"

    # --- Playwright globals ---

    def test_no_playwright_globals(self, stealth_page):
        """No Playwright-injected globals should be visible."""
        leaked = stealth_page.evaluate("""
            () => {
                const suspicious = [
                    '__pwInitScripts', '__playwright__binding__',
                    '__playwright_evaluation_script__', '__pw_manual'
                ];
                const names = Object.getOwnPropertyNames(window);
                return suspicious.filter(s => names.includes(s));
            }
        """)
        assert leaked == [], f"Playwright globals leaked: {leaked}"

    # --- chrome.runtime ---

    def test_chrome_runtime_exists(self, stealth_page):
        """window.chrome.runtime must exist as object."""
        assert stealth_page.evaluate("typeof window.chrome.runtime") == "object"

    # --- Iframe consistency ---

    def test_webdriver_false_in_iframe(self, stealth_page):
        """navigator.webdriver must be false inside same-origin iframe."""
        webdriver_in_iframe = stealth_page.evaluate("""
            () => new Promise(resolve => {
                const iframe = document.createElement('iframe');
                iframe.srcdoc = '<html><body></body></html>';
                iframe.onload = () => {
                    const val = iframe.contentWindow.navigator.webdriver;
                    iframe.remove();
                    resolve(val);
                };
                document.body.appendChild(iframe);
            })
        """)
        assert webdriver_in_iframe is False

    # --- Worker value consistency ---

    def test_worker_values_consistent(self, stealth_page):
        """Worker navigator values must match main thread."""
        result = stealth_page.evaluate("""
            () => new Promise(resolve => {
                const mainValues = {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    languages: JSON.stringify(navigator.languages),
                    hardwareConcurrency: navigator.hardwareConcurrency
                };
                const code = `self.postMessage({
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    languages: JSON.stringify(navigator.languages),
                    hardwareConcurrency: navigator.hardwareConcurrency
                })`;
                const blob = new Blob([code], {type: 'application/javascript'});
                const w = new Worker(URL.createObjectURL(blob));
                w.onmessage = e => {
                    w.terminate();
                    const workerValues = e.data;
                    resolve({
                        userAgent: mainValues.userAgent === workerValues.userAgent,
                        platform: mainValues.platform === workerValues.platform,
                        languages: mainValues.languages === workerValues.languages,
                        hardwareConcurrency: mainValues.hardwareConcurrency === workerValues.hardwareConcurrency
                    });
                };
            })
        """)
        for key, matches in result.items():
            assert matches, f"Worker {key} doesn't match main thread"

    # --- WebGL spoof verification ---

    def test_webgl_vendor_override(self, stealth_page):
        """WebGL UNMASKED_VENDOR should match CLI flag."""
        vendor = stealth_page.evaluate("""
            () => {
                const c = document.createElement('canvas');
                const gl = c.getContext('webgl');
                if (!gl) return null;
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
            }
        """)
        if vendor is None:
            pytest.skip("WebGL debug_renderer_info unavailable (no GPU)")
        assert vendor == "NVIDIA Corporation", f"WebGL vendor: {vendor}"

    def test_webgl_renderer_override(self, stealth_page):
        """WebGL UNMASKED_RENDERER should match CLI flag."""
        renderer = stealth_page.evaluate("""
            () => {
                const c = document.createElement('canvas');
                const gl = c.getContext('webgl');
                if (!gl) return null;
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
            }
        """)
        if renderer is None:
            pytest.skip("WebGL debug_renderer_info unavailable (no GPU)")
        assert renderer == "NVIDIA GeForce RTX 3070", f"WebGL renderer: {renderer}"

    # --- Client Hints platform consistency ---

    def test_client_hints_platform_consistent(self, stealth_page):
        """navigator.userAgentData.platform must match --fingerprint-platform."""
        result = stealth_page.evaluate("""
            async () => {
                const uad = navigator.userAgentData;
                if (!uad) return { error: 'no userAgentData' };
                const low = uad.platform;
                const high = await uad.getHighEntropyValues(['platform']);
                return { low, high: high.platform };
            }
        """)
        assert "error" not in result, result.get("error", "")
        assert result["low"] == "Windows", f"Low-entropy platform: {result['low']}"
        assert result["high"] == "Windows", f"High-entropy platform: {result['high']}"

    # --- Screen resolution ---

    def test_screen_resolution_not_headless_default(self, stealth_page):
        """Screen dimensions should not be the headless default 800x600."""
        dims = stealth_page.evaluate(
            "() => ({ w: screen.width, h: screen.height })"
        )
        is_default = dims["w"] == 800 and dims["h"] == 600
        assert not is_default, "Screen resolution is headless default 800x600"


class TestBotDetectionSites:
    """Live bot detection services — DOM-inspected results."""

    @pytest.mark.slow
    @pytest.mark.timeout(45)
    def test_device_and_browser_info(self, live_page):
        """deviceandbrowserinfo.com should report isBot=false with no flags."""
        live_page.goto("https://deviceandbrowserinfo.com/are_you_a_bot", timeout=30000)
        live_page.wait_for_timeout(8000)
        result = live_page.evaluate("""
            () => {
                const text = document.body.innerText;
                const match = text.match(/\\{[\\s\\S]*"isBot"[\\s\\S]*\\}/);
                if (match) {
                    try { return JSON.parse(match[0]); } catch(e) {}
                }
                const result = {};
                const lines = text.split('\\n');
                for (const line of lines) {
                    const kv = line.match(/^\\s*(\\w+)\\s*[:=]\\s*(true|false|\\d+)/i);
                    if (kv) result[kv[1]] = kv[2].toLowerCase() === 'true' ? true :
                                            kv[2].toLowerCase() === 'false' ? false : Number(kv[2]);
                }
                return Object.keys(result).length > 0 ? result : { raw: text.substring(0, 2000) };
            }
        """)
        if "isBot" in result:
            assert result["isBot"] is False, f"Detected as bot: {result}"
        detection_keys = [
            "isAutomatedWithCDP", "hasHeadlessUA", "hasWebDriverFlag",
            "hasInconsistentClientHints", "hasInconsistentWorkerValues",
        ]
        for key in detection_keys:
            if key in result:
                assert result[key] is False, f"{key} flagged as True"

    @pytest.mark.slow
    @pytest.mark.timeout(45)
    def test_browserscan(self, live_page):
        """BrowserScan should show Normal / not detected as bot."""
        live_page.goto("https://www.browserscan.net/bot-detection", timeout=30000)
        live_page.wait_for_timeout(8000)
        result = live_page.evaluate("""
            () => {
                const text = document.body.innerText.toLowerCase();
                return {
                    hasNormal: text.includes('normal'),
                    hasBot: text.includes('bot detected') || text.includes('is a bot'),
                    pageText: text.substring(0, 2000)
                };
            }
        """)
        assert not result["hasBot"], f"Detected as bot on BrowserScan"
        if result["hasNormal"]:
            pass
        else:
            assert len(result["pageText"]) > 50, "BrowserScan page didn't load"

    @pytest.mark.slow
    @pytest.mark.timeout(30)
    def test_fingerprintjs(self, live_page):
        """FingerprintJS should not flag as bot."""
        live_page.goto("https://demo.fingerprint.com/playground", timeout=30000)
        live_page.wait_for_timeout(5000)
        result = live_page.evaluate("""
            () => {
                const text = document.body.innerText.toLowerCase();
                return {
                    hasBot: text.includes('bot detected') || text.includes('bot: yes'),
                    pageText: text.substring(0, 1000)
                };
            }
        """)
        assert not result["hasBot"], "FingerprintJS flagged as bot"

    @pytest.mark.slow
    @pytest.mark.timeout(60)
    def test_recaptcha_v3(self, live_page):
        """reCAPTCHA v3 score should be present in page."""
        live_page.goto(
            "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php",
            timeout=30000,
        )
        live_page.wait_for_timeout(3000)
        content = live_page.content()
        assert "score" in content.lower()

    @pytest.mark.slow
    @pytest.mark.timeout(45)
    def test_whatismybrowser(self, live_page):
        """whatismybrowser.com detected OS should match actual OS."""
        live_page.goto("https://www.whatismybrowser.com/", timeout=30000)
        live_page.wait_for_timeout(2000)
        # Dismiss cookie consent if present
        try:
            consent = live_page.locator("button:has-text('Consent')")
            if consent.count() > 0:
                consent.first.click()
                live_page.wait_for_timeout(1000)
        except Exception:
            pass

        result = live_page.evaluate("""
            () => {
                const major = document.querySelector(".string-major");
                const minor = document.querySelector(".string-minor");
                return {
                    detected: major ? major.textContent.trim() : "",
                    os_detail: minor ? minor.textContent.trim() : "",
                    user_agent: navigator.userAgent,
                    platform: navigator.platform,
                    ua_platform: navigator.userAgentData
                        ? navigator.userAgentData.platform : "N/A",
                };
            }
        """)
        detected = result["detected"].lower()
        ua = result["user_agent"].lower()
        plat = result["platform"].lower()
        ua_plat = result["ua_platform"].lower()

        actual_os = platform.system()  # Darwin, Linux, Windows
        if actual_os == "Darwin":
            # All signals should say macOS
            assert "mac" in ua, f"UA doesn't mention mac: {result['user_agent']}"
            assert plat == "macintel", f"platform mismatch: {plat}"
            assert ua_plat == "macos", f"Client Hints mismatch: {ua_plat}"
            assert "windows" not in detected and "linux" not in detected, \
                f"Site detected wrong OS: {result['detected']}"
        elif actual_os == "Linux":
            assert "linux" in ua, f"UA doesn't mention linux: {result['user_agent']}"
            assert "linux" in plat, f"platform mismatch: {plat}"
            assert ua_plat == "linux", f"Client Hints mismatch: {ua_plat}"
            assert "windows" not in detected and "mac" not in detected, \
                f"Site detected wrong OS: {result['detected']}"
