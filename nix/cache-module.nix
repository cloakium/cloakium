{ ... }:
{
  nix.settings.extra-substituters = [
    "https://github.com/cloakium/cloakium/releases/latest/download"
  ];
  nix.settings.extra-trusted-public-keys = [
    "cloakium-1:yn82u2+10K6r6PGVQZvqRYzeAHoQBCeoorLEFK/G9Gg="
  ];
}
