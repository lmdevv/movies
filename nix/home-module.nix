# Home Manager module for the `movies` CLI, on Linux or macOS:
#
#   programs.movies = {
#     enable = true;
#     convexUrl = "http://nas.tailnet.ts.net:3210";
#     mediaUrl = "http://nas.tailnet.ts.net:8080";
#   };
#
# You still run `movies login` once (or set MOVIES_API_KEY), so no key enters the Nix store.
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
    home.packages = [ cfg.package ];
    home.sessionVariables = shared.sessionVariables cfg;
  };
}
