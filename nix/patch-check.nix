{
  pkgs,
  applyCloakiumPatches,
}:

let
  base = pkgs.chromium.browser;
in
pkgs.stdenv.mkDerivation {
  pname = "chromium-patch-check";
  inherit (base) version;

  # Only chromium/src: all cloakium patches touch this repository, not a DEPS
  # sub-checkout. This makes source replay cheap (1.3 GiB, no compilation).
  src = base.passthru.chromiumDeps.src;

  nativeBuildInputs = [ pkgs.zstd ];

  unpackPhase = ''
    runHook preUnpack
    mkdir -p src
    pushd src
    unpackFile "$src"
    popd
    sourceRoot=src
    runHook postUnpack
  '';

  # Shared strict replay: fuzz=0 + sentinel assertions.
  postPatch = applyCloakiumPatches;

  dontConfigure = true;
  dontBuild = true;
  doCheck = false;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    printf '%s\n' "$version" > "$out/version"
    runHook postInstall
  '';

  meta = {
    description = "Source-only replay of cloakium Chromium patches (no compile)";
    license = pkgs.lib.licenses.bsd3;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
