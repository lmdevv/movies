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
in
{
  options.programs.movies = {
    enable = lib.mkEnableOption "the [movies] command line";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./cli.nix { };
      defaultText = lib.literalExpression "movies.packages.\${system}.cli";
      description = "The `movies` CLI package.";
    };

    convexUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:3210";
      description = ''
        The server's Convex URL, set as `MOVIES_CONVEX_URL` in your session, so `movies login`
        needs no `--server`. A profile saved for another server stays unused while it is set.
      '';
    };

    mediaUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:8080";
      description = "The server's web app and stream URL, set as `MOVIES_MEDIA_URL`.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    home.sessionVariables =
      lib.optionalAttrs (cfg.convexUrl != null) { MOVIES_CONVEX_URL = cfg.convexUrl; }
      // lib.optionalAttrs (cfg.mediaUrl != null) { MOVIES_MEDIA_URL = cfg.mediaUrl; };
  };
}
