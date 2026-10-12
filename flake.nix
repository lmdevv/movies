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
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      packages = forLinux (pkgs: rec {
        movies = pkgs.callPackage ./nix/package.nix { };
        default = movies;
      });

      nixosModules.default = import ./nix/module.nix;

      # Evaluates the module in minimal systems, so `nix flake check` catches option and type
      # errors, builds the package, and shellchecks the startup script.
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
          module = evaluate { };
          module-qsv = evaluate {
            hardwareAcceleration = "qsv";
            openFirewall = true;
            tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
            otlpEndpoint = "http://127.0.0.1:4318";
          };
        }
      );
    };
}
