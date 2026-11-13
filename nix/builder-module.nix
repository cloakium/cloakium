{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.cloakium-builder;
in
{
  options.services.cloakium-builder = {
    enable = lib.mkEnableOption "a repository-scoped Cloakium release builder";
    tokenFile = lib.mkOption {
      type = lib.types.externalPath;
      description = "Secret file outside the Nix store containing a runner-scoped access token.";
    };
    url = lib.mkOption {
      type = lib.types.str;
      default = "https://github.com/cloakium/cloakium";
      description = "Repository to which this dedicated release runner is registered.";
    };
    workDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/cloakium-builder";
      description = "Disposable runner workspace; allow at least 150 GiB free disk.";
    };
  };

  config = lib.mkIf cfg.enable {
    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];
    nix.settings.extra-system-features = [ "big-parallel" ];
    users.groups.cloakium-builder = { };
    users.users.cloakium-builder = {
      isSystemUser = true;
      group = "cloakium-builder";
      home = cfg.workDir;
      createHome = true;
    };
    services.github-runners.cloakium = {
      enable = true;
      inherit (cfg) url tokenFile workDir;
      user = "cloakium-builder";
      group = "cloakium-builder";
      ephemeral = true;
      replace = true;
      extraLabels = [ "cloakium-chromium" ];
      extraPackages = [
        pkgs.nix
        pkgs.jujutsu
        pkgs.gitMinimal
        pkgs.gh
        pkgs.coreutils
        pkgs.bash
        pkgs.gnutar
        pkgs.gzip
        pkgs.zstd
      ];
    };
  };
}
