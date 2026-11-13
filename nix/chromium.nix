{
  pkgsChromium,
  patches ? [ ],
  # GN/Chromium API key. Empty by default: no nixpkgs Google key is shipped.
  googleApiKey ? "",
}:

let
  lib = pkgsChromium.lib;
  base = pkgsChromium.chromium;

  # Unrelated repository edits must not invalidate the native build.
  patchFiles = map (
    patch:
    builtins.path {
      path = patch;
      name = baseNameOf (toString patch);
    }
  ) patches;

  # Strict replay shared by the real build and #chromium-patch-check.
  applyCloakiumPatches = lib.concatMapStringsSep "\n" (patch: ''
    echo "cloakium: applying ${toString patch}"
    patch -p1 --fuzz=0 --no-backup-if-mismatch < ${patch}
  '') patchFiles + "\n" + lib.concatMapStringsSep "\n" (
    sentinel: ''
      grep -qF ${lib.escapeShellArg sentinel.text} ${lib.escapeShellArg sentinel.file}
    ''
  ) sentinels;

  sentinels = [
    {
      file = "third_party/blink/public/common/switches.h";
      text = "kCloakiumFingerprint";
    }
    {
      file = "third_party/blink/renderer/core/frame/cloakium_fingerprint.cc";
      text = "PixelHash";
    }
    {
      file = "third_party/blink/renderer/core/frame/navigator.cc";
      text = "cloakium::IsFingerprintEnabled";
    }
    {
      file = "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc";
      text = "kCloakiumHardwareConcurrency";
    }
    {
      file = "third_party/blink/renderer/core/frame/navigator_device_memory.cc";
      text = "kCloakiumDeviceMemory";
    }
    {
      file = "components/embedder_support/user_agent_utils.cc";
      text = "kCloakiumFingerprint";
    }
    {
      file = "third_party/blink/renderer/core/html/canvas/html_canvas_element.cc";
      text = "PerturbStaticBitmapImage";
    }
    {
      file = "third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc";
      text = "PerturbRgbaPixels";
    }
    {
      file = "third_party/blink/renderer/core/offscreencanvas/offscreen_canvas.cc";
      text = "PerturbStaticBitmapImage";
    }
    {
      file = "third_party/blink/renderer/modules/webaudio/offline_audio_context.cc";
      text = "PerturbAudioSamples";
    }
    {
      file = "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc";
      text = "GetWebglRendererOverride";
    }
    {
      file = "content/browser/renderer_host/render_process_host_impl.cc";
      text = "kCloakiumSwitches";
    }
  ];

  # Replace the nixpkgs-embedded Google API key with an explicit value.
  sanitizeGoogleKey =
    phase:
    let
      keyLists = builtins.filter builtins.isList (
        builtins.split "google_api_key=\"([^\"]*)\"" phase
      );
      key = if keyLists == [ ] then null else builtins.head (builtins.head keyLists);
      # GN string literal; the whole flags string is already shell-escaped.
      safeKey = builtins.replaceStrings [ "\"" "\\" ] [ "" "" ] googleApiKey;
      replacement = builtins.replaceStrings
        [ ''google_api_key="${key}"'' ]
        [ ''google_api_key="${safeKey}"'' ]
        phase;
    in
    if key == null || key == "" then phase else replacement;

  browser = base.browser.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + "\n" + applyCloakiumPatches;
    configurePhase = sanitizeGoogleKey (old.configurePhase or "");
  });

  baseBrowserPath = builtins.unsafeDiscardStringContext (toString base.browser);
  baseSandboxPath = builtins.unsafeDiscardStringContext (toString base.browser.sandbox);

  wrapper = base.overrideAttrs (old: {
    buildCommand = (builtins.replaceStrings
      [ baseBrowserPath baseSandboxPath ]
      [ (toString browser) (toString browser.sandbox) ]
      old.buildCommand
    ) + ''
      ln -sf "$out/bin/chromium" "$out/bin/cloakium-chromium"
    '';

    passthru = old.passthru // {
      inherit applyCloakiumPatches;
      unwrapped = browser;
      inherit (browser) version;
    };

    meta = old.meta // {
      description = "Chromium with cloakium native fingerprint-privacy patches";
      # Both Linux targets build from this expression; only x86_64-linux is
      # tested and claimed in the docs.
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      license = lib.licenses.bsd3;
      mainProgram = "chromium";
    };
  });
in
wrapper
