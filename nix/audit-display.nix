{
  lib,
  rustPlatform,
  xvfb,
  openbox,
  xprop,
  xdpyinfo,
}:

let
  crate = ../tools/audit-display;
in
rustPlatform.buildRustPackage {
  pname = "cloakium-audit-display";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = crate;
    fileset = lib.fileset.unions [
      (crate + "/Cargo.toml")
      (crate + "/Cargo.lock")
      (crate + "/src")
    ];
  };

  cargoLock.lockFile = crate + "/Cargo.lock";

  # Baked into the binary with option_env!, so `start` never depends on the
  # caller's PATH. Each value can still be overridden at runtime with the
  # matching CLOAKIUM_AUDIT_* variable.
  env = {
    CLOAKIUM_AUDIT_XVFB = "${xvfb}/bin/Xvfb";
    CLOAKIUM_AUDIT_OPENBOX = "${openbox}/bin/openbox";
    CLOAKIUM_AUDIT_XPROP = "${xprop}/bin/xprop";
    CLOAKIUM_AUDIT_XDPIINFO = "${xdpyinfo}/bin/xdpyinfo";
  };

  # The unit tests are pure logic (paths, manifest, pid guards); no X server is
  # started during the build. The runtime selftest runs outside the sandbox.
  doCheck = true;

  meta = {
    description = "Owned, dynamically allocated X display for Cloakium audits";
    license = lib.licenses.mit;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    mainProgram = "cloakium-audit-display";
  };
}
