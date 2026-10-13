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
            # spumux renders the demo library's image (VobSub) subtitle.
            pkgs.dvdauthor
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      packages = forLinux (pkgs: rec {
        movies = pkgs.callPackage ./nix/package.nix { };
        default = movies;
      });

      # `pkgs.movies` for configurations that apply it; the module builds the same package.
      overlays.default = final: _prev: {
        movies = final.callPackage ./nix/package.nix { };
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
          vm = pkgs.callPackage ./nix/vm-test.nix { module = self.nixosModules.movies; };
        }
      );
    };
}
