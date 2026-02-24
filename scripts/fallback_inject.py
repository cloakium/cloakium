#!/usr/bin/env python3
"""Version-independent fallback code injection for stealth patches.

Called when patch(1) fails due to context mismatch between Chromium versions.
Uses regex-based find-and-insert to apply changes regardless of minor version
differences in surrounding code.
"""
import re, sys, os


def inject_after_pattern(filepath, pattern, code, flags=0):
    """Insert code after the first line matching pattern."""
    with open(filepath) as f:
        content = f.read()
    match = re.search(pattern, content, flags)
    if not match:
        return False
    pos = match.end()
    # Insert after the matched text
    content = content[:pos] + code + content[pos:]
    with open(filepath, "w") as f:
        f.write(content)
    return True


def replace_block(filepath, start_pattern, replacement):
    """Replace a brace-delimited block starting with start_pattern.
    The pattern MUST end with the opening { of the block."""
    with open(filepath) as f:
        content = f.read()
    match = re.search(start_pattern, content, re.DOTALL)
    if not match:
        print(f"    DEBUG: pattern not found in {filepath}")
        # Show first 500 chars around 'DOMPluginArray' for diagnosis
        idx = content.find("DOMPluginArray::DOMPluginArray")
        if idx >= 0:
            print(f"    DEBUG: found at {idx}: {content[idx:idx+200]!r}")
        return False
    start = match.start()
    # The regex already matched the opening {, so start counting from depth=1
    depth = 1
    i = match.end()
    while i < len(content):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
        i += 1
    else:
        print(f"    DEBUG: no matching close brace found")
        return False
    content = content[:start] + replacement + content[end:]
    with open(filepath, "w") as f:
        f.write(content)
    return True


# ── Fallback handlers for each patch ────────────────────────────────

def fallback_01():
    """CLI switches — add fingerprint switch declarations."""
    cc = "content/public/common/content_switches.cc"
    hh = "content/public/common/content_switches.h"

    code_cc = '''
// Stealth fingerprint switches for per-session variation.
const char kFingerprint[] = "fingerprint";
const char kFingerprintPlatform[] = "fingerprint-platform";
const char kFingerprintHardwareConcurrency[] =
    "fingerprint-hardware-concurrency";
const char kFingerprintGpuVendor[] = "fingerprint-gpu-vendor";
const char kFingerprintGpuRenderer[] = "fingerprint-gpu-renderer";

'''
    if not inject_after_pattern(
        cc,
        r'const char kEnableAutomation\[\] = "enable-automation";',
        code_cc,
    ):
        print(f"  WARN: Could not find anchor in {cc}")
        return False

    code_hh = """CONTENT_EXPORT extern const char kFingerprint[];
CONTENT_EXPORT extern const char kFingerprintPlatform[];
CONTENT_EXPORT extern const char kFingerprintHardwareConcurrency[];
CONTENT_EXPORT extern const char kFingerprintGpuVendor[];
CONTENT_EXPORT extern const char kFingerprintGpuRenderer[];
"""
    if not inject_after_pattern(
        hh,
        r"CONTENT_EXPORT extern const char kEnableAutomation\[\];",
        "\n" + code_hh,
    ):
        print(f"  WARN: Could not find anchor in {hh}")
        return False
    return True


def fallback_02():
    """Navigator webdriver + platform override."""
    f = "third_party/blink/renderer/core/frame/navigator.cc"
    with open(f) as fh:
        content = fh.read()

    # Part 1: platform override
    platform_code = """
  // Stealth: check CLI flag first
  const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
  if (cmd->HasSwitch("fingerprint-platform")) {
    std::string plat = cmd->GetSwitchValueASCII("fingerprint-platform");
    if (plat == "windows")
      return "Win32";
    if (plat == "macos" || plat == "mac")
      return "MacIntel";
    if (plat == "linux")
      return "Linux x86_64";
    return String(plat);
  }
"""
    if "fingerprint-platform" not in content:
        content = re.sub(
            r"(String Navigator::platform\(\) const \{)\n",
            r"\1\n" + platform_code,
            content,
            count=1,
        )

    # Part 2: webdriver() returns false
    if "return false;" not in content.split("webdriver()")[1].split("}")[0] if "webdriver()" in content else "":
        content = re.sub(
            r"bool Navigator::webdriver\(\) const \{[^}]+\}",
            "bool Navigator::webdriver() const {\n  return false;\n}",
            content,
            count=1,
        )

    with open(f, "w") as fh:
        fh.write(content)
    return True


def fallback_05():
    """Hardware concurrency override."""
    f = "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc"
    code = """\
  const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
  if (cmd->HasSwitch("fingerprint-hardware-concurrency")) {
    int value;
    if (base::StringToInt(
            cmd->GetSwitchValueASCII("fingerprint-hardware-concurrency"),
            &value) &&
        value > 0) {
      return static_cast<unsigned>(value);
    }
  }
"""
    return inject_after_pattern(
        f,
        r"NavigatorConcurrentHardware::hardwareConcurrency\(\) const \{\n",
        code,
    )


def fallback_06():
    """WebGL GPU vendor/renderer spoof."""
    f = "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc"
    with open(f) as fh:
        content = fh.read()

    renderer_code = """\
        const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
        if (cmd->HasSwitch("fingerprint-gpu-renderer")) {
          return WebGLAny(
              script_state,
              String(cmd->GetSwitchValueASCII("fingerprint-gpu-renderer")));
        }
"""
    vendor_code = """\
        const base::CommandLine* cmd2 = base::CommandLine::ForCurrentProcess();
        if (cmd2->HasSwitch("fingerprint-gpu-vendor")) {
          return WebGLAny(
              script_state,
              String(cmd2->GetSwitchValueASCII("fingerprint-gpu-vendor")));
        }
"""
    if "fingerprint-gpu-renderer" not in content:
        content = re.sub(
            r"(case WebGLDebugRendererInfo::kUnmaskedRendererWebgl:\s*if \(ExtensionEnabled\(kWebGLDebugRendererInfoName\)\) \{\n)",
            r"\1" + renderer_code,
            content,
            count=1,
        )
    if "fingerprint-gpu-vendor" not in content:
        content = re.sub(
            r"(case WebGLDebugRendererInfo::kUnmaskedVendorWebgl:\s*if \(ExtensionEnabled\(kWebGLDebugRendererInfoName\)\) \{\n)",
            r"\1" + vendor_code,
            content,
            count=1,
        )

    with open(f, "w") as fh:
        fh.write(content)
    return True


def fallback_08():
    """Audio frequency data noise injection."""
    f = "third_party/blink/renderer/modules/webaudio/realtime_analyser.cc"
    with open(f) as fh:
        content = fh.read()

    # Detect whether UNSAFE_TODO macro is used in this version
    uses_unsafe = "UNSAFE_TODO(destination[i])" in content
    access = "UNSAFE_TODO(destination[i])" if uses_unsafe else "destination[i]"

    code = f"""

    // Stealth: add per-session noise to audio frequency data
    const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
    if (cmd->HasSwitch("fingerprint")) {{
      int seed = 0;
      base::StringToInt(cmd->GetSwitchValueASCII("fingerprint"), &seed);
      for (unsigned i = 0; i < len; ++i) {{
        uint32_t h = i ^ static_cast<uint32_t>(seed);
        h = (h ^ (h >> 16)) * 0x45d9f3b;
        h = h ^ (h >> 16);
        float noise = ((h & 0xFF) / 255.0f - 0.5f) * 0.0002f;
        {access} += noise;
      }}
    }}"""

    if "Stealth: add per-session noise to audio" in content:
        return True

    # Find the destination[i] = ... db_mag line and the closing brace after it
    # Pattern handles both UNSAFE_TODO and non-UNSAFE_TODO versions
    pattern = r"((?:UNSAFE_TODO\()?destination\[i\](?:\))?\s*=\s*static_cast<float>\(db_mag\);\s*\})"
    match = re.search(pattern, content)
    if match:
        content = content[: match.end()] + code + content[match.end() :]
        with open(f, "w") as fh:
            fh.write(content)
        return True
    return False


def fallback_11():
    """Plugins always present — replace IsPdfViewerAvailable() with true."""
    f = "third_party/blink/renderer/modules/plugins/dom_plugin_array.cc"
    with open(f) as fh:
        content = fh.read()

    if "Stealth: always report PDF" in content:
        return True
    if "IsPdfViewerAvailable()" not in content:
        return False

    # Only replace the if-call, not the function definition
    content = content.replace(
        "if (IsPdfViewerAvailable())",
        "if (true /* Stealth: always report PDF plugins */)",
        1,  # replace only first occurrence
    )

    with open(f, "w") as fh:
        fh.write(content)
    return True


FALLBACKS = {
    "01-cli-switches.patch": fallback_01,
    "02-navigator-webdriver-platform.patch": fallback_02,
    "05-hardware-concurrency-override.patch": fallback_05,
    "06-webgl-gpu-spoof.patch": fallback_06,
    "08-audio-noise.patch": fallback_08,
    "11-plugins-always-present.patch": fallback_11,
}


def main():
    failed = []
    for name in sys.argv[1:]:
        handler = FALLBACKS.get(name)
        if handler:
            print(f"  Fallback: {name}")
            if handler():
                print(f"    OK")
            else:
                print(f"    FAILED")
                failed.append(name)
        else:
            print(f"  No fallback for {name}")
            failed.append(name)

    if failed:
        print(f"\n::error::Patches with no fallback: {', '.join(failed)}")
        sys.exit(1)
    print("All fallbacks applied successfully.")


if __name__ == "__main__":
    main()
