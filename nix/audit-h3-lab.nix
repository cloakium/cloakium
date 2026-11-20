{
  lib,
  rustPlatform,
}:
rustPlatform.buildRustPackage {
  pname = "cloakium-lab-h3";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../tools/audit-h3-lab;
    fileset = lib.fileset.unions [
      ../tools/audit-h3-lab/Cargo.toml
      ../tools/audit-h3-lab/Cargo.lock
      ../tools/audit-h3-lab/src
    ];
  };
  cargoLock.lockFile = ../tools/audit-h3-lab/Cargo.lock;
  doCheck = true;
  meta = {
    description = "Original loopback HTTP/3 and TLS fixture for browser audits";
    license = lib.licenses.mit;
    mainProgram = "cloakium-lab-h3";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
