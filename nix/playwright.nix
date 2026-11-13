# Build the pinned Playwright package with original Cloakium patches.
{
  lib,
  stdenv,
  fetchurl,
  nodejs,
  rustPlatform,
}:
let
  upstream = builtins.fromJSON (builtins.readFile ../upstream.json);
  inherit (upstream) playwright;
  patchSource = builtins.path {
    path = ../patches/playwright;
    name = "cloakium-playwright-patches";
  };

  patcher = rustPlatform.buildRustPackage {
    pname = "playwright-patcher";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ../tools/playwright-patcher;
      fileset = lib.fileset.unions [
        ../tools/playwright-patcher/Cargo.toml
        ../tools/playwright-patcher/Cargo.lock
        ../tools/playwright-patcher/src
        ../tools/playwright-patcher/tests
      ];
    };
    cargoLock.lockFile = ../tools/playwright-patcher/Cargo.lock;
    doCheck = true;
    meta = {
      description = "Deterministic strict patch replay for Cloakium's playwright-core";
      license = lib.licenses.mit;
      mainProgram = "playwright-patcher";
    };
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "playwright-core";
  version = playwright.version;

  src = fetchurl {
    url = playwright.url;
    hash = playwright.hash;
  };

  sourceRoot = "package";
  nativeBuildInputs = [
    nodejs
    patcher
  ];
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    mkdir -p "$TMPDIR/stage"
    playwright-patcher apply \
      --source . \
      --target "$TMPDIR/stage" \
      --patches ${patchSource} \
      --patch-set "playwright-${finalAttrs.version}"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/node_modules" "$out/bin"
    cp -a "$TMPDIR/stage" "$out/lib/node_modules/playwright-core"

    printf '%s\n' \
      "This package is a modified build of playwright-core ${finalAttrs.version}." \
      "Upstream: ${playwright.url}" \
      "Modifications: Cloakium patch set (MIT), see CLOAKIUM-PATCHES.json." \
      "Upstream licensing: Apache-2.0, see LICENSE and NOTICE in this directory." \
      > "$out/lib/node_modules/playwright-core/CLOAKIUM-NOTICE"

    printf '%s\n' \
      '#!/bin/sh' \
      "exec ${nodejs}/bin/node \"$out/lib/node_modules/playwright-core/cli.js\" \"\$@\"" \
      > "$out/bin/playwright"
    chmod +x "$out/bin/playwright"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    ${nodejs}/bin/node -e '
      const manifest = require(process.argv[1]);
      const marker = manifest.cloakium;
      const version = process.argv[2];
      if (!marker || !marker.patched)
        throw new Error("playwright-core is missing a truthy cloakium manifest marker");
      if (marker.version !== version || manifest.version !== version)
        throw new Error("cloakium marker version does not match the package version");
      if (marker.patchSet !== "playwright-" + version)
        throw new Error("cloakium marker patchSet is not derived from the package version");
      if (!String(marker.source).endsWith("/playwright-core-" + version + ".tgz"))
        throw new Error("cloakium marker source URL does not match the package version");
    ' "$out/lib/node_modules/playwright-core/package.json" "${finalAttrs.version}"

    ${nodejs}/bin/node -e '
      const fs = require("fs");
      const text = fs.readFileSync(process.argv[1], "utf8");
      if (text.includes("          this._client.send(\"Runtime.enable\", {}),"))
        throw new Error("patched bundle still enables the Runtime domain unconditionally");
      for (const marker of ["_cloakiumUtilityWorldName", "_cloakiumRuntimeDomainEnabled"])
        if (!text.includes(marker))
          throw new Error("patched bundle is missing " + marker);
    ' "$out/lib/node_modules/playwright-core/lib/coreBundle.js"

    "$out/bin/playwright" --version
    runHook postInstallCheck
  '';

  passthru = {
    libPath = "${finalAttrs.finalPackage}/lib/node_modules/playwright-core";
    nodeModules = finalAttrs.finalPackage.passthru.libPath;
    inherit patcher;
    upstream = playwright;
  };

  meta = {
    description = "Cloakium-patched playwright-core ${playwright.version}";
    homepage = "https://github.com/microsoft/playwright";
    license = lib.licenses.asl20;
    platforms = lib.platforms.unix;
    mainProgram = "playwright";
  };
})
