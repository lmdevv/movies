# NixOS module for the `movies` CLI. A host that runs services.movies gets it already pointed at
# that server (nix/module.nix). Any other machine that talks to the same server imports just this
# module (`movies.nixosModules.cli`) and sets:
#
#   programs.movies = {
#     enable = true;
#     convexUrl = "http://nas.tailnet.ts.net:3210";
#     mediaUrl = "http://nas.tailnet.ts.net:8080";
#   };
#
# Each user still runs `movies login` once (or sets MOVIES_API_KEY), so no key enters the Nix
# store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.movies;

  shared = import ./cli-options.nix { inherit lib pkgs; };
in
{
  options.programs.movies = shared.options;

  config = lib.mkIf cfg.enable {
    environment = {
      systemPackages = [ cfg.package ];
      sessionVariables = shared.sessionVariables cfg;
    };
  };
}
