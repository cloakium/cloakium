{
  lib,
  rustPlatform,
  makeWrapper,
  nix,
  nodejs_26,
  gitMinimal,
  gh,
}:
let
  runtimePath = lib.makeBinPath [
    nix
    nodejs_26
    gitMinimal
    gh
  ];
  source = lib.fileset.toSource {
    root = ../tools/maintain;
    fileset = lib.fileset.unions [
      ../tools/maintain/Cargo.toml
      ../tools/maintain/Cargo.lock
      ../tools/maintain/src
      ../tools/maintain/tests
    ];
  };
in
rustPlatform.buildRustPackage {
  pname = "cloakium-maintain";
  version = "0.1.0";

  src = source;
  cargoLock.lockFile = ../tools/maintain/Cargo.lock;
  nativeBuildInputs = [ makeWrapper ];

  postFixup = ''
    wrapProgram "$out/bin/cloakium-maintain" \
      --prefix PATH : ${runtimePath}
  '';

  # Store integration probes run outside the build sandbox.
  doCheck = true;

  meta = {
    description = "Cloakium upstream candidate preparation, staged release signing and throttled draft uploads";
    longDescription = ''
      `cloakium-maintain update` tracks the latest stable playwright-core and
      Chromium pin without publishing anything. `validate-update` accepts only
      the pin changes an update may make. `release` stages a flat Nix cache,
      optionally unsigned, and `sign-release` re-verifies and signs it with the
      trusted publisher key. `upload-release` resumes a draft release with one
      upload in flight at a time, spaced content operations, and a final
      server-digest check against the signed checksums. The wrapper provides
      `gh` so uploads need no separately installed GitHub CLI.
    '';
    license = lib.licenses.mit;
    mainProgram = "cloakium-maintain";
    platforms = lib.platforms.unix;
  };
}
