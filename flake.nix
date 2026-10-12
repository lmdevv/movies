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
    };
}
