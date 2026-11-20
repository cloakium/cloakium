{
  lib,
  rustPlatform,
  makeWrapper,
  nodejs_26,
  fontconfig,
  openssl,
  audit-display,
  audit-h3-lab,
}:
rustPlatform.buildRustPackage {
  pname = "cloakium-audit";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../tools/browser-audit/Cargo.toml
      ../tools/browser-audit/Cargo.lock
      ../tools/browser-audit/src
      ../tools/browser-audit/tests
      ../tests/audit/schema
    ];
  };
  cargoRoot = "tools/browser-audit";
  buildAndTestSubdir = "tools/browser-audit";
  cargoLock.lockFile = ../tools/browser-audit/Cargo.lock;
  nativeBuildInputs = [ makeWrapper ];
  doCheck = true;
  postFixup = ''
    wrapProgram "$out/bin/cloakium-audit" \
      --prefix PATH : ${lib.makeBinPath [ nodejs_26 ]} \
      --set CLOAKIUM_H3_BIN ${lib.getExe audit-h3-lab} \
      --set CLOAKIUM_AUDIT_DISPLAY_BIN ${lib.getExe audit-display} \
      --set CLOAKIUM_FC_LIST_BIN ${fontconfig}/bin/fc-list \
      --set OPENSSL_BIN ${lib.getExe openssl}
  '';
  meta = {
    description = "Private browser inventory, reproducible audit plans and evidence-backed gap catalogues";
    license = lib.licenses.mit;
    mainProgram = "cloakium-audit";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
