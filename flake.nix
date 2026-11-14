{
  description = "Cloakium: native Chromium privacy patches for Playwright";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  nixConfig = {
    extra-substituters = [ "https://github.com/cloakium/cloakium/releases/latest/download" ];
    extra-trusted-public-keys = [ "cloakium-1:yn82u2+10K6r6PGVQZvqRYzeAHoQBCeoorLEFK/G9Gg=" ];
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: lib.genAttrs systems f;

      # Applied in lexicographic order by the shared strict replay script.
      chromiumPatches = [
        ./patches/chromium/0001-cloakium-switches.patch
        ./patches/chromium/0002-cloakium-fingerprint-core.patch
        ./patches/chromium/0003-navigator-webdriver.patch
        ./patches/chromium/0004-navigator-hardware.patch
        ./patches/chromium/0005-user-agent-headless.patch
        ./patches/chromium/0006-canvas-readback-noise.patch
        ./patches/chromium/0007-audio-offline-noise.patch
        ./patches/chromium/0008-webgl-profile.patch
        ./patches/chromium/0009-renderer-switch-forwarding.patch
      ];

      perSystem =
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          chromium = import ./nix/chromium.nix {
            pkgsChromium = pkgs;
            patches = chromiumPatches;
          };
          chromium-unwrapped = chromium.passthru.unwrapped;
          chromium-patch-check = import ./nix/patch-check.nix {
            inherit pkgs;
            inherit (chromium.passthru) applyCloakiumPatches;
          };

          maintain = pkgs.callPackage ./nix/maintain.nix { };
          playwright = pkgs.callPackage ./nix/playwright.nix { nodejs = pkgs.nodejs_26; };
          playwright-patcher = playwright.patcher;
          browser = import ./nix/browser.nix {
            inherit pkgs chromium playwright;
          };

          devPackages = with pkgs; [
            rustc
            cargo
            rustfmt
            clippy
            nodejs_26
            bun
            typescript
            jq
            nixfmt
            patch
            gitMinimal
            jujutsu
            gh
            prefetch-npm-deps
            actionlint
          ];
          devShellInputs = {
            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = [ pkgs.xz ];
          };
        in
        {
          packages = {
            inherit
              chromium
              chromium-unwrapped
              chromium-patch-check
              maintain
              playwright
              playwright-patcher
              browser
              ;
            default = chromium;
          };

          apps = {
            default = {
              type = "app";
              program = "${chromium}/bin/cloakium-chromium";
              meta = chromium.meta;
            };
            chromium = {
              type = "app";
              program = "${chromium}/bin/cloakium-chromium";
              meta = chromium.meta;
            };
            cloakium-chromium = {
              type = "app";
              program = "${chromium}/bin/cloakium-chromium";
              meta = chromium.meta;
            };
          };

          checks = {
            inherit chromium-patch-check;
          };

          # No Chromium build is pulled in by the default shell. Opt into the
          # patched binary explicitly with `nix develop .#with-chromium`.
          devShells.default = pkgs.mkShell (
            devShellInputs
            // {
              packages = devPackages;
            }
          );

          devShells.with-chromium = pkgs.mkShell (
            devShellInputs
            // {
              packages = devPackages ++ [ chromium ];
              CLOAKIUM_BINARY_PATH = "${chromium}/bin/cloakium-chromium";
            }
          );
        };
    in
    {
      packages = forAllSystems (system: (perSystem system).packages);
      apps = forAllSystems (system: (perSystem system).apps);
      checks = forAllSystems (system: (perSystem system).checks);
      devShells = forAllSystems (system: (perSystem system).devShells);

      overlays.default = final: _prev: {
        cloakium-chromium = import ./nix/chromium.nix {
          pkgsChromium = final;
          patches = chromiumPatches;
        };
        cloakium = {
          chromium = final.cloakium-chromium;
          unwrapped = final.cloakium-chromium.passthru.unwrapped;
          patch-check = import ./nix/patch-check.nix {
            pkgs = final;
            inherit (final.cloakium-chromium.passthru) applyCloakiumPatches;
          };
        };
      };

      nixosModules = {
        cache = import ./nix/cache-module.nix;
        builder = import ./nix/builder-module.nix;
      };
    };
}
