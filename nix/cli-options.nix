# The `programs.movies` options and session variables that the NixOS (cli-module.nix) and Home
# Manager (home-module.nix) modules share.
{ lib, pkgs }:
{
  options = {
    enable = lib.mkEnableOption "the [movies] command line";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./cli.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./cli.nix { }";
      description = ''
        The `movies` CLI package, built with your nixpkgs. On a nixpkgs too old to build it, use
        the flake's own: `movies.packages.''${pkgs.stdenv.hostPlatform.system}.cli`.
      '';
    };

    convexUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:3210";
      description = ''
        The server's Convex URL, set as `MOVIES_CONVEX_URL`, so `movies login` needs no
        `--server`. A profile saved for another server stays unused while it is set.
      '';
    };

    mediaUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:8080";
      description = "The server's web app and stream URL, set as `MOVIES_MEDIA_URL`.";
    };
  };

  sessionVariables =
    cfg:
    lib.optionalAttrs (cfg.convexUrl != null) { MOVIES_CONVEX_URL = cfg.convexUrl; }
    // lib.optionalAttrs (cfg.mediaUrl != null) { MOVIES_MEDIA_URL = cfg.mediaUrl; };
}
