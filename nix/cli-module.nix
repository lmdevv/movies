# NixOS module for the `movies` CLI. A host that runs services.movies gets it already pointed at
# that server. Any other machine that talks to the same server imports just this module
# (`movies.nixosModules.cli`) and sets:
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

  service = config.services.movies;

  # Imported alone (nixosModules.cli), the server's options do not exist.
  serving = config.services.movies.enable or false;
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
      defaultText = lib.literalExpression "if config.services.movies.enable then config.services.movies.convexPublicUrl else null";
      example = "http://nas.tailnet.ts.net:3210";
      description = ''
        The server's Convex URL, exported to every user as `MOVIES_CONVEX_URL`, so `movies login`
        needs no `--server`. A profile saved for another server stays unused while it is set.
      '';
    };

    mediaUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      defaultText = lib.literalExpression "if config.services.movies.enable then config.services.movies.publicUrl else null";
      example = "http://nas.tailnet.ts.net:8080";
      description = "The server's web app and stream URL, exported as `MOVIES_MEDIA_URL`.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.enable {
      environment = {
        systemPackages = [ cfg.package ];
        sessionVariables =
          lib.optionalAttrs (cfg.convexUrl != null) { MOVIES_CONVEX_URL = cfg.convexUrl; }
          // lib.optionalAttrs (cfg.mediaUrl != null) { MOVIES_MEDIA_URL = cfg.mediaUrl; };
      };
    })

    (lib.mkIf serving {
      programs.movies = {
        enable = lib.mkDefault true;
        convexUrl = lib.mkDefault service.convexPublicUrl;
        mediaUrl = lib.mkDefault service.publicUrl;
      };
    })
  ];
}
