{
  pkgs,
  chromium,
  playwright,
}:
let
  inherit (pkgs) lib;
  nodejs = pkgs.nodejs_26;
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  source = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        relative = lib.removePrefix (toString ../. + "/") (toString path);
        top = builtins.head (lib.splitString "/" relative);
      in
      type == "directory" && relative == toString ../.
      || builtins.elem top [
        "src"
        "tests"
        "scripts"
        "docs"
      ]
      || builtins.elem relative [
        "package.json"
        "package-lock.json"
        "tsconfig.json"
        "LICENSE"
        "README.md"
      ];
  };
in
pkgs.buildNpmPackage (finalAttrs: {
  pname = "cloakium-browser";
  inherit nodejs;
  inherit (manifest) version;
  src = source;
  npmDepsHash = import ./npm-deps-hash.nix;
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ pkgs.makeWrapper ];

  preBuild = ''
    rm -rf node_modules/playwright-core
    ln -s ${playwright.libPath} node_modules/playwright-core
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    package=$out/lib/node_modules/@cloakium/browser
    mkdir -p "$package/node_modules" $out/bin
    cp -r dist package.json LICENSE "$package/"
    if [ -d docs ]; then cp -r docs "$package/"; fi
    if [ -f README.md ]; then cp README.md "$package/"; fi
    ln -s ${playwright.libPath} "$package/node_modules/playwright-core"
    makeWrapper ${lib.getExe nodejs} $out/bin/cloakium-node \
      --set CLOAKIUM_MODULE "$package/dist/index.js" \
      --set CLOAKIUM_PLAYWRIGHT_MODULE ${playwright.libPath}/index.mjs \
      --prefix NODE_PATH : "$out/lib/node_modules"
    runHook postInstall
  '';

  passthru = {
    libPath = "${finalAttrs.finalPackage}/lib/node_modules/@cloakium/browser";
    inherit chromium playwright;
  };
  meta = {
    description = "Independently authored Playwright browser library and Node environment";
    license = [
      lib.licenses.mit
      lib.licenses.asl20
    ];
    homepage = "https://github.com/cloakium/cloakium";
    mainProgram = "cloakium-node";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
