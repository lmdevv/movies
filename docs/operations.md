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

## Upgrading

Releases are git tags `vX.Y.Z`. Each one publishes the image as `X.Y.Z`, `X.Y`, and `latest`
(pre-releases such as `v0.2.0-rc.1` only as `0.2.0-rc.1`); `main` publishes `:main`, the edge,
and every build also gets `sha-<commit>`. The NixOS module follows whatever revision the flake
input points at.

| Track     | Compose `MOVIES_IMAGE`                              | NixOS flake input             |
| --------- | --------------------------------------------------- | ----------------------------- |
| A release | `ghcr.io/lmdevv/movies:latest`, `:0.2`, or `:0.2.1` | `github:lmdevv/movies/v0.2.1` |
| Edge      | `ghcr.io/lmdevv/movies:main`                        | `github:lmdevv/movies`        |

### Compose

Keep the checkout and `MOVIES_IMAGE` on the same release: `compose.yaml` pins the Convex backend
that release was tested with, and the image derives the Convex admin key with that backend's
tool. The entrypoint logs a warning when the image was built for another backend than
`compose.yaml` runs. `:latest` follows the newest release whatever the checkout, so pin the version
when you check out a tag.

```sh
cd movies && git fetch --tags && git checkout v0.2.0      # or `git pull` on main for the edge
cd deploy/compose
# .env: MOVIES_IMAGE=ghcr.io/lmdevv/movies:0.2.0             # or :main for the edge
docker compose pull
docker compose up -d
docker compose logs -f movies    # "upgrading from 0.1.0 to 0.2.0; backing up to ... first"
```

### NixOS

```sh
nix flake update movies          # or point the input at the new tag
nixos-rebuild switch
journalctl -u movies -f
```

### What an upgrade does

The first start of a new version exports a backup, `movies-manual-<timestamp>.zip`, before it
deploys the new functions. A new version is a new release or any build whose Convex functions
differ: the image records a hash of its bundled functions, the NixOS module the package's store
path, so following `main` or building locally backs up too. Convex refuses to deploy a schema the
stored documents do not match, so such a deploy fails and the start stops with the old functions
still in place; restarts after that do not export again for the same version. Convex backend
upgrades ride along with [movies] releases; never change its image on your own.

### Rolling back

1. Go back to the previous version: `git checkout v0.1.0` and its image tag
   (`MOVIES_IMAGE=ghcr.io/lmdevv/movies:0.1.0`, then `docker compose up -d`), or
   `nixos-rebuild switch --rollback`.
2. If the older functions start, restore the `movies-manual-…` archive the upgrade took (Admin →
   Backups, or `movies restore`). If they do not deploy over the newer data, restore without the
   media service (above) and start it again.

### Releasing

For maintainers: set `version` in `packages/backend/package.json` to `X.Y.Z` on `main`, then tag
and push the tag. The image workflow refuses a tag that does not match that version, runs the
packaged-stack smoke test, and publishes the multi-arch image.

```sh
git tag -a v0.2.0 -m "[movies] 0.2.0" && git push origin v0.2.0
```

## Remote access

Both ports listen on `127.0.0.1` by default. For use away from home, put the host on a Tailscale
tailnet and set the bind address (`MOVIES_BIND` on Compose, `listenAddress` on NixOS) to the
host's Tailscale address, or keep localhost and use `tailscale serve`. Do not expose either port
to the internet: Convex and the media service speak plain HTTP, and the Convex port must be
reachable by every browser and CLI that uses [movies].

## Hardware acceleration

The media service uses Intel Quick Sync (QSV) through ffmpeg's libvpl when it can, then VA-API
(Intel and AMD), and falls back to software encoding when a GPU run fails.

- Compose: add `-f compose.qsv.yaml` (or `-f compose.vaapi.yaml` for VA-API) to pass `/dev/dri`
  through. The image carries Debian's ffmpeg 7.1 (built with libvpl), Intel's iHD VA-API driver,
  the oneVPL GPU runtime, and Mesa's VA-API drivers (amd64). Quick Sync covers Gen12 and newer
  iGPUs (Tiger Lake onwards) and Arc cards; older Intel iGPUs and AMD GPUs encode through VA-API.
- NixOS: `hardwareAcceleration = "qsv"` enables `hardware.graphics` with `intel-media-driver` and
  `vpl-gpu-rt`, gives the service the DRM render nodes and the `render` and `video` groups, and
  uses `ffmpeg-full` (the default nixpkgs `ffmpeg` has no libvpl). `"auto"` grants the devices and
  probes them without changing the host's graphics configuration. `"vaapi"` does the same for
  VA-API, with `vaapiDevice` for the render node.
- Verified on an Arc A380 in both installs (`QSV=1 scripts/stack-e2e.sh`,
  `HARDWARE_ACCELERATION=auto scripts/nixos-module-e2e.sh`).

## Telemetry and logs

- Logs are one JSON object per line on standard output (`docker compose logs movies`,
  `journalctl -u movies`). The media service keeps the same lines, already redacted, in rotating
  NDJSON files under its data folder (`/data/media/logs` in the Compose volume,
  `/var/lib/movies/media/logs` on NixOS): a new file each day, at each start, and at an eighth of
  `LOG_MAX_MB` (512), deleted after `LOG_RETENTION_DAYS` (14) and oldest first beyond the size
  cap. `LOG_LEVEL` (`info`) sets the least severe level for both.
- `movies logs` reads the retained log without SSH or `sudo`: `--follow`, `--since 15m` or a time,
  `--until`, `--level warn`, `--session-id`, `--stream-id`, `--slow 1s`, `--grep`, and `--json` for
  NDJSON. It needs an admin session. The service streams it as NDJSON from `POST /api/logs` and
  answers at most 5000 records before following.
- A failed media request (any 4xx or 5xx on `/media/`) logs `MediaRoutes.request_failed` at `WARN`
  with its playback session, and every HLS segment logs how long it took, split into waiting for
  the encoder, reading the disk, and writing to the network: `MediaRoutes.slow_segment` at `WARN`
  from one second, `MediaRoutes.segment` at `DEBUG` below. Stream starts, encoder restarts, mode
  changes, and ends (with the reason, such as `idle`) log at `INFO`.
- The web and iOS players report their stalls, errors, dropped frames (web only), hls.js segment
  load times, and recoveries to `POST /api/playback/diagnostics` with their playback token, in
  batches the service validates and limits per session. They land in the same log as `Player.*`
  records. `movies diagnostics playback <session-id>` builds a session's timeline from both sides;
  admins read any session and other accounts only their own. Audio/video drift is not measured:
  no player reports it.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` (Compose) or `otlpEndpoint` (NixOS) set to an OTLP/HTTP
  collector, the media service exports traces and logs: library scans, playback negotiation, the
  first HLS segment, seeks, encoder failures and GPU-to-software fallbacks, backups and restores, and
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
