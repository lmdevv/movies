{
  description = "[movies]: self-hosted movies and TV for people and agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      linuxSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forLinux = f: nixpkgs.lib.genAttrs linuxSystems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            # ffmpeg-full carries libvpl (Intel QSV); the default ffmpeg does not.
            pkgs.ffmpeg-full
            # scripts/demo-library.sh: downloads, Blender zips, and spumux with a known font for
            # the image (VobSub) subtitle.
            pkgs.curl
            pkgs.unzip
            pkgs.dvdauthor
            pkgs.fontconfig
          ];
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      # The server is Linux only; the CLI also builds on macOS.
      packages = forAllSystems (
        pkgs:
        let
          cli = pkgs.callPackage ./nix/cli.nix { };
        in
        {
          inherit cli;
          default = cli;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux rec {
          movies = pkgs.callPackage ./nix/package.nix { };
          default = movies;
        }
      );

      # `nix run github:lmdevv/movies -- whoami`; `nix build` still builds the server.
      apps = forAllSystems (
        pkgs:
        let
          movies = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.cli;
            meta.description = "The [movies] command line";
          };
        in
        {
          default = movies;
          cli = movies;
        }
      );

      # `pkgs.movies` and `pkgs.movies-cli` for configurations that apply it; the module builds the
      # same server package.
      overlays.default = final: _prev: {
        movies = final.callPackage ./nix/package.nix { };
        movies-cli = final.callPackage ./nix/cli.nix { };
      };

      nixosModules = {
        movies = import ./nix/module.nix;
        default = self.nixosModules.movies;
      };

      # Builds the package, evaluates the module in minimal systems (catching option and type
      # errors and shellchecking the startup script), and boots it in a NixOS VM (`vm`).
      checks = forLinux (
        pkgs:
        let
          evaluate =
            settings:
            let
              evaluated = nixpkgs.lib.nixosSystem {
                inherit (pkgs.stdenv.hostPlatform) system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "26.05";
                    services.movies = {
                      enable = true;
                      libraryDirs = [ "/srv/media/movies" ];
                    }
                    // settings;
                  }
                ];
              };
              inherit (evaluated) config;
              service = config.systemd.services.movies;
            in
            pkgs.writeText "movies-module-check" (
              builtins.toJSON {
                container = {
                  inherit (config.virtualisation.oci-containers.containers.movies-convex)
                    image
                    ports
                    volumes
                    environment
                    ;
                };
                inherit (service) environment serviceConfig;
                firewall = config.networking.firewall.allowedTCPPorts;
                groups = config.users.users.movies.extraGroups;
              }
            );
        in
        {
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.movies;
          # Builds the CLI, so a stale pnpm dependency hash fails `nix flake check`.
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) cli;
          module = evaluate { };
          module-qsv = evaluate {
            hardwareAcceleration = "qsv";
            openFirewall = true;
            tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
            environmentFile = "/run/secrets/movies.env";
            otlpEndpoint = "http://127.0.0.1:4318";
            qsvDevice = "/dev/dri/renderD129";
            extraEnvironment.LIBVA_DRIVER_NAME = "iHD";
          };
          module-vaapi = evaluate {
            hardwareAcceleration = "vaapi";
            vaapiDevice = "/dev/dri/renderD129";
            libraryWatch = "poll";
            libraryPollSeconds = 120;
          };
          # programs.movies: on with the server and pointed at it, alone on a machine without one,
          # and off when asked.
          cli-module =
            let
              system =
                settings:
                (nixpkgs.lib.nixosSystem {
                  inherit (pkgs.stdenv.hostPlatform) system;
                  modules = [
                    self.nixosModules.default
                    {
                      boot.isContainer = true;
                      system.stateVersion = "26.05";
                    }
                    settings
                  ];
                }).config;
              summary = config: {
                cli = builtins.any (package: package.pname or "" == "movies-cli") config.environment.systemPackages;
                convexUrl = config.environment.sessionVariables.MOVIES_CONVEX_URL or null;
                mediaUrl = config.environment.sessionVariables.MOVIES_MEDIA_URL or null;
                server = config.systemd.services ? movies;
              };
              actual = {
                server = summary (system {
                  services.movies = {
                    enable = true;
                    publicUrl = "http://nas:8080";
                    convexPublicUrl = "http://nas:3210";
                  };
                });
                cliOnly = summary (system {
                  programs.movies = {
                    enable = true;
                    convexUrl = "http://nas:3210";
                    mediaUrl = "http://nas:8080";
                  };
                });
                withoutCli = summary (system {
                  services.movies.enable = true;
                  programs.movies.enable = false;
                });
              };
              expected = {
                server = {
                  cli = true;
                  convexUrl = "http://nas:3210";
                  mediaUrl = "http://nas:8080";
                  server = true;
                };
                cliOnly = {
                  cli = true;
                  convexUrl = "http://nas:3210";
                  mediaUrl = "http://nas:8080";
                  server = false;
                };
                withoutCli = {
                  cli = false;
                  convexUrl = null;
                  mediaUrl = null;
                  server = true;
                };
              };
            in
            assert nixpkgs.lib.assertMsg (
              actual == expected
            ) "programs.movies: expected ${builtins.toJSON expected}, got ${builtins.toJSON actual}";
            pkgs.writeText "movies-cli-module-check" (builtins.toJSON actual);
          vm = pkgs.callPackage ./nix/vm-test.nix { module = self.nixosModules.movies; };
        }
      );
    };
}
