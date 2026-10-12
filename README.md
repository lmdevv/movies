# [movies]

Self-hosted movies and TV for people and agents. Stream your own folders or NAS from one install,
with profiles, Netflix-style browsing, watching together at the same second, migration from
Jellyfin and Plex, and a CLI that can do everything the app can.

Early development: the MVP (media service, web app, SDK, CLI) is in place; native apps come later.

## Stack

- Convex (self-hosted) for product state, auth, and live sync
- A Node + Effect HttpApi media service for scanning, direct play, HLS remux, and Intel QSV
  transcoding with ffmpeg; it also serves the web app
- A Vite + React + TanStack Router web app
- An Effect SDK and CLI with an agent skill
- Docker Compose or a NixOS module

## Install with Docker Compose

```sh
git clone https://github.com/lmdevv/movies && cd movies/deploy/compose
cp .env.example .env    # set MOVIES_LIBRARY, the two public URLs, and PUID/PGID
docker compose up -d
```

Open `MOVIES_PUBLIC_URL` (default `http://localhost:8080`), create the owner account (the first
account is the owner), and add `/media/library` (or a folder in it) as a library.

- The `movies` image (`ghcr.io/lmdevv/movies`, published from `main` and version tags) holds the
  media service, the web app, the Convex CLI with the bundled functions, and ffmpeg.
  `docker compose build` builds it from source instead.
- Each start deploys the functions and configures the deployment; secrets are generated inside
  Convex, never written to `.env`.
- The media service runs as `PUID:PGID`, which must be able to read the library. Libraries mount
  read-only; add one line per folder under `volumes:` in `compose.yaml`.
- Intel Quick Sync: `docker compose -f compose.yaml -f compose.qsv.yaml up -d`.
- A local OpenTelemetry collector: `docker compose --profile telemetry up -d` with
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`.

## Install on NixOS

```nix
# flake.nix
inputs.movies.url = "github:lmdevv/movies";

# configuration.nix, with inputs.movies.nixosModules.default in modules
services.movies = {
  enable = true;
  libraryDirs = [ "/srv/media/movies" "/srv/media/shows" ];
  listenAddress = "100.64.0.1";                       # the host's Tailscale address
  publicUrl = "http://nas.tailnet.ts.net:8080";
  convexPublicUrl = "http://nas.tailnet.ts.net:3210";
  hardwareAcceleration = "qsv";                       # Intel Gen12+ iGPU or Arc
  tmdbApiKeyFile = "/run/secrets/tmdb-api-key";       # agenix, sops-nix, or a root-only file
};
```

The Convex backend runs as a pinned OCI container; the media service runs natively as a sandboxed
systemd service built from this repository (`nix build github:lmdevv/movies#movies`). Library
folders are read-only to it, and `openFirewall` is off by default.

## Configuration

Compose reads these names from `deploy/compose/.env` (see `.env.example`); the NixOS options are
in brackets.

| Name                          | Meaning                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `MOVIES_LIBRARY`              | Host folder mounted read-only at `/media/library` (`libraryDirs`)      |
| `MOVIES_PUBLIC_URL`           | URL of the web app and streams (`publicUrl`)                           |
| `CONVEX_PUBLIC_URL`           | URL browsers and the CLI use for Convex (`convexPublicUrl`)            |
| `MOVIES_BIND`                 | Address both ports listen on, `127.0.0.1` by default (`listenAddress`) |
| `MOVIES_PORT`, `CONVEX_PORT`  | Ports, 8080 and 3210 (`port`, `convexPort`)                            |
| `PUID`, `PGID`                | User and group of the media service (`user`, `group`)                  |
| `TMDB_API_KEY`                | TMDB key or read token for metadata and artwork (`tmdbApiKeyFile`)     |
| `HARDWARE_ACCELERATION`       | `auto`, `qsv`, or `none` (`hardwareAcceleration`)                      |
| `MAX_CONCURRENT_TRANSCODES`   | Simultaneous transcodes, 3 (`maxConcurrentTranscodes`)                 |
| `BACKUP_RETENTION_DAYS`       | Days of nightly backups kept, 14 (`backupRetentionDays`)               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional OTLP/HTTP collector for traces and logs (`otlpEndpoint`)      |
| `MOVIES_IMAGE`, `TZ`          | Image to run; time zone                                                |

The media service's own settings are listed in `apps/media/README.md`.

## Remote access

Keep both ports off the internet. For use away from home, join the host to a Tailscale tailnet and
bind to its Tailscale address (`MOVIES_BIND` / `listenAddress`), or keep the localhost default and
use `tailscale serve`. Convex and the media service speak plain HTTP, and every browser and CLI
must reach both ports.

## Backups and restore

Every night at 03:00 UTC the media service exports the whole database, file storage included, to
the backup folder (`/data/backups` in the `movies-data` volume, or `backupDir` on NixOS) and keeps
14 days. Each upgrade also backs up before it deploys. Restore from Admin → Backups, or:

```sh
movies backup --wait
movies backups list
movies restore movies-nightly-2026-10-12T03-00-00-000Z.zip   # everyone signs in again
```

Archives hold password hashes; store copies as carefully as the server. See
[docs/operations.md](docs/operations.md) for restoring onto a new machine or without the media
service.

## CLI

```sh
pnpm install && pnpm --filter @movies/cli build    # puts apps/cli/dist/movies.js in place
alias movies="node $PWD/apps/cli/dist/movies.js"

movies login --server http://nas.tailnet.ts.net:3210 --media-url http://nas.tailnet.ts.net:8080
movies search alien
movies play "Alien" --open        # mpv; without --open, prints the stream URL
movies libraries list --human
```

Output is JSON by default. Agents get an API key from Settings → API keys and follow
[apps/cli/skills/movies/SKILL.md](apps/cli/skills/movies/SKILL.md).

## Telemetry

No analytics and no phoning home. Logs are JSON lines with tokens, keys, and passwords redacted;
traces and logs go to your own OTLP collector only when you set one. Details in
[docs/operations.md](docs/operations.md).

## Development

```sh
nix develop                  # Node 24, pnpm, ffmpeg-full
pnpm install
scripts/dev-stack.sh up      # a Convex backend for this worktree
pnpm dev                     # web on :3001 and Convex dev
pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test
scripts/stack-e2e.sh         # build the image and test the packaged install
nix flake check              # build the Nix package and evaluate the NixOS module
```

See `AGENTS.md` for the layout, rules, and checks, and `docs/` for decisions and operations.

## License

[movies] is MIT-licensed. The self-hosted Convex backend it runs (`ghcr.io/get-convex/convex-backend`)
is FSL-1.1-Apache-2.0: each release converts to Apache-2.0 two years after it ships. The image
includes Debian's ffmpeg (LGPL/GPL) and the non-free build of Intel's media driver, whose
encoding kernels are proprietary; the NixOS module uses nixpkgs `ffmpeg-full`.
