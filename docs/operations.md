# Operations

Running a [movies] install: what the two installs do at startup, where state lives, backups and
restores, upgrades, hardware acceleration, and telemetry. The README has the quick start.

## What runs

| Piece          | Compose (`deploy/compose`)            | NixOS (`services.movies`)                   |
| -------------- | ------------------------------------- | ------------------------------------------- |
| Convex backend | `convex` service, pinned image        | `movies-convex` OCI container, pinned image |
| Media service  | `movies` image, runs as `PUID:PGID`   | native `movies.service`, user `movies`      |
| Web app        | served by the media service           | served by the media service                 |
| Database       | `convex-data` volume                  | `dataDir/convex`                            |
| Service state  | `movies-data` volume, `/data/media`   | `dataDir/media`                             |
| Backups        | `movies-data` volume, `/data/backups` | `backupDir` (`/var/lib/movies/backups`)     |
| HLS segments   | `movies-transcode` volume             | `transcodeDir` (`/var/cache/movies/...`)    |
| Libraries      | bind mounts under `/media`, read-only | `libraryDirs`, read-only to the service     |

Every start, as root, before the media service runs unprivileged:

1. Derive the Convex admin key from the backend's instance secret. It is never written to disk
   except into the service's private environment under `/run/movies` (tmpfs).
2. If the image or package version changed, export a backup first
   (`movies-manual-<timestamp>.zip`).
3. Deploy the bundled Convex functions.
4. Configure the deployment (`packages/backend/scripts/configure.ts`): Convex Auth's JWT keys,
   `SITE_URL`, `MEDIA_BASE_URL`, `PLAYBACK_TOKEN_SECRET`, and the media service's restricted key.
   Existing secrets are kept, so this is safe to repeat.
5. Write the public Convex URL into a copy of the web app.
6. Start the media service with its secrets in `/run/movies/media.env` (mode 0600, owned by the
   service user). No secret is in the image, the Nix store, a command line, or the web app.

## Backups

- A Convex cron requests a backup every night at 03:00 UTC. The media service runs it as a job:
  `convex export --include-file-storage` into a hidden partial file in the backup folder, renamed
  to `movies-nightly-<timestamp>.zip` only when the export succeeded.
- Archives are `0600` in a `0700` folder owned by the service user: they hold every account's
  password hash and the media service key's hash. Copy them off the machine with the same care.
- After a new backup succeeds, archives older than `BACKUP_RETENTION_DAYS` (14) are deleted. The
  new archive is never deleted, and nothing is pruned after a failed backup.
- Back up now: Admin → Backups in the web app, or `movies backup --wait`.
- Deployment environment variables (JWT keys, playback secret, service key) are not part of an
  export. A restore keeps the current ones and the startup configuration fills in anything
  missing.

## Restore

Admin → Backups → Restore in the web app, or with the CLI as an admin:

```sh
movies backups list
movies restore movies-nightly-2026-10-12T03-00-00-000Z.zip
```

The media service (`POST /api/backups/restore`) then:

1. runs `convex import --replace-all` with the archive (only archives inside the backup folder),
2. registers its own key again (the snapshot may come from another deployment),
3. settles the jobs the snapshot caught mid-run (`maintenance:settleRestoredJobs`),
4. ends every session (`maintenance:endAllSessions`): everyone, including the admin who
   restored, signs in again; the media service signs back in by itself,
5. lists the archives on disk again, since the snapshot's backup list is older.

The restore replaces everything in Convex: accounts, profiles, libraries, history, and rooms.
Files on disk are not touched; the next library scan reconciles them.

### Restoring onto a new machine

1. Install [movies] (Compose or NixOS) and start it once.
2. Copy the archive into the backup folder (`docker compose cp backup.zip movies:/data/backups/`
   and `docker compose exec movies chown movies:movies /data/backups/backup.zip`, or into
   `backupDir` owned by `movies` on NixOS) and restart the media service, which lists it.
3. Create a temporary owner account in the web app (the first account on an empty deployment is
   the owner), then restore the archive as above. The temporary account is replaced by the
   snapshot's accounts.
4. Mount the libraries at the same paths as before, or edit each library's folders afterwards.

### Restoring without the media service

If the media service cannot start, restore with the Convex CLI in the image:

```sh
docker compose exec movies sh -c '
  export CONVEX_SELF_HOSTED_URL=http://convex:3210
  export CONVEX_SELF_HOSTED_ADMIN_KEY="$(sed -n "s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p" /run/movies/media.env)"
  cd /app/backend
  node node_modules/convex/bin/main.js import --replace-all --yes /data/backups/<archive>.zip
  node node_modules/convex/bin/main.js run maintenance:settleRestoredJobs
  node node_modules/convex/bin/main.js run maintenance:endAllSessions'
docker compose restart movies   # configures again and re-registers the service key
```

On NixOS, run the same commands as root with `movies-convex` (from the package) in place of
`node node_modules/convex/bin/main.js`, `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210`, the
admin key from `/run/movies/media.env`, then `systemctl restart movies`.

## Upgrades

Pull the new image (`docker compose pull && docker compose up -d`) or update the flake input and
rebuild. The first start of a new version backs up before it deploys the new functions, so a bad
upgrade can be rolled back by starting the old version and restoring that archive.

## Remote access

Both ports listen on `127.0.0.1` by default. For use away from home, put the host on a Tailscale
tailnet and set the bind address (`MOVIES_BIND` on Compose, `listenAddress` on NixOS) to the
host's Tailscale address, or keep localhost and use `tailscale serve`. Do not expose either port
to the internet: Convex and the media service speak plain HTTP, and the Convex port must be
reachable by every browser and CLI that uses [movies].

## Hardware acceleration

The media service uses Intel Quick Sync (QSV) through ffmpeg's libvpl when it can, and falls back
to software encoding when a QSV run fails.

- Compose: add `-f compose.qsv.yaml` to pass `/dev/dri` through. The image carries Debian's ffmpeg
  7.1 (built with libvpl), Intel's iHD VA-API driver, and the oneVPL GPU runtime (amd64), which
  cover Gen12 and newer iGPUs (Tiger Lake onwards) and Arc cards. Older iGPUs need the retired
  Media SDK runtime, which the image does not carry; they transcode in software.
- NixOS: `hardwareAcceleration = "qsv"` enables `hardware.graphics` with `intel-media-driver` and
  `vpl-gpu-rt`, gives the service the DRM render nodes and the `render` and `video` groups, and
  uses `ffmpeg-full` (the default nixpkgs `ffmpeg` has no libvpl). `"auto"` grants the devices and
  probes them without changing the host's graphics configuration.
- Verified on an Arc A380 in both installs (`QSV=1 scripts/stack-e2e.sh`,
  `HARDWARE_ACCELERATION=auto scripts/nixos-module-e2e.sh`).

## Telemetry and logs

- Logs are one JSON object per line on standard output (`docker compose logs movies`,
  `journalctl -u movies`).
- With `OTEL_EXPORTER_OTLP_ENDPOINT` (Compose) or `otlpEndpoint` (NixOS) set to an OTLP/HTTP
  collector, the media service exports traces and logs: library scans, playback negotiation, the
  first HLS segment, seeks, encoder failures and QSV fallbacks, backups and restores, and
  migrations. `docker compose --profile telemetry up -d` starts a local collector that prints
  them (`deploy/compose/otel-collector.yaml`).
- Every log line and export is redacted on the way out: fields named like credentials and values
  shaped like tokens, API keys, Convex admin keys, and credential query parameters. Playback URLs
  carry tokens, so automatic HTTP spans for `/media/` are off as well.
- [movies] sends nothing anywhere else: no analytics, no update checks. The Convex backend runs
  with `DISABLE_BEACON=1`.

## Verifying an install

- `scripts/stack-e2e.sh` builds the image and runs the packaged suite against a fresh Compose
  stack: privilege and secret checks, owner sign-up, library, scan, direct and HLS playback, a
  media restart (streams answer a typed `StreamNotFound`, then play again), CLI backup and
  restore, and an upgrade backup. CI runs it on every image change.
- `scripts/nixos-module-e2e.sh` does the same against the NixOS module's own unit on a NixOS host
  (needs sudo and Docker), and checks the sandbox.
- `nix flake check` evaluates the module and builds the package.
