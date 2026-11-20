{
  lib,
  rustPlatform,
  makeWrapper,
  symlinkJoin,
  chromium,
}:

let
  launcher = rustPlatform.buildRustPackage {
    pname = "cloakium-launcher";
    version = chromium.version;

    src = lib.fileset.toSource {
      root = ../tools/launcher;
      fileset = lib.fileset.unions [
        ../tools/launcher/Cargo.toml
        ../tools/launcher/Cargo.lock
        ../tools/launcher/src
        ../tools/launcher/tests
      ];
    };

    cargoLock.lockFile = ../tools/launcher/Cargo.lock;
    # The exec-test fixture is not a public executable.
    cargoBuildFlags = [
      "--bin"
      "cloakium-chromium"
    ];
    doCheck = true;

    meta = {
      description = "Zero-dependency argv shaper for Cloakium's headless desktop profile";
      license = lib.licenses.mit;
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      mainProgram = "cloakium-chromium";
    };
  };
in
symlinkJoin {
  name = "cloakium-chromium-${chromium.version}";
  version = chromium.version;
  paths = [ chromium ];
  nativeBuildInputs = [ makeWrapper ];

  postBuild = ''
    rm -f "$out/bin/cloakium-chromium" "$out/bin/chromium" "$out/bin/chromium-browser"
    makeWrapper ${launcher}/bin/cloakium-chromium "$out/bin/cloakium-chromium" \
      --set CLOAKIUM_REAL_CHROMIUM "${chromium}/bin/chromium"
    ln -s cloakium-chromium "$out/bin/chromium"
    ln -s cloakium-chromium "$out/bin/chromium-browser"
  '';

  passthru = chromium.passthru // {
    inherit launcher;
  };

  meta = chromium.meta // {
    license = lib.unique (lib.toList chromium.meta.license ++ [ lib.licenses.mit ]);
    mainProgram = "cloakium-chromium";
  };
}
