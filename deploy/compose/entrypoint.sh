#!/usr/bin/env bash
# [movies] container entrypoint. Runs as root once per start, then becomes the unprivileged media
# service:
#   1. derives the Convex admin key from the backend's instance secret (never stored),
#   2. exports a pre-upgrade backup when the image version changed,
#   3. deploys the bundled Convex functions and configures the deployment idempotently (JWT keys,
#      PLAYBACK_TOKEN_SECRET, the media service key, SITE_URL, MEDIA_BASE_URL),
#   4. writes the Convex URL into a copy of the web app,
#   5. execs the media service as PUID:PGID with the secrets in its environment only.
set -euo pipefail
umask 077

log() { echo "[movies] $*" >&2; }

data=/data
public_url="${MOVIES_PUBLIC_URL%/}"
convex_public_url="${CONVEX_PUBLIC_URL%/}"
convex_url="${CONVEX_URL%/}"
credentials="${CONVEX_CREDENTIALS_DIR:-/run/convex-credentials}"
# The release plus a hash of the bundled Convex functions and their dependencies (written at build
# time by deploy/functions-hash.sh), so any image whose functions differ, such as a newer `main` or
# a local build, backs up before it deploys.
version="$(node -p 'require("/app/backend/package.json").version')"
if [ -s /app/backend/.functions-hash ]; then
  version="$version+$(cat /app/backend/.functions-hash)"
fi
puid="${PUID:-1000}"
pgid="${PGID:-1000}"

if ! [[ "$puid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ ]] || [ "$puid" = 0 ] || [ "$pgid" = 0 ]; then
  log "PUID and PGID must be numeric and not 0 (root); got PUID=$puid PGID=$pgid"
  exit 1
fi

[ "$(id -g movies)" = "$pgid" ] || groupmod --non-unique --gid "$pgid" movies
[ "$(id -u movies)" = "$puid" ] || usermod --non-unique --uid "$puid" --gid "$pgid" movies

# The media user reads /dev/dri for Quick Sync when the host passes it through.
for node in /dev/dri/renderD*; do
  [ -e "$node" ] || continue
  gid="$(stat -c %g "$node")"
  getent group "$gid" >/dev/null || groupadd --gid "$gid" "render$gid"
  usermod -a -G "$(getent group "$gid" | cut -d: -f1)" movies
done

# Service state and backups belong to the media user; nobody else reads them.
install -d -m 700 -o movies -g movies "$data/media" "$data/backups" /transcode
find "$data/media" "$data/backups" /transcode \( \! -user movies -o \! -group movies \) \
  -exec chown -h movies:movies {} +

convex_up() {
  CONVEX_VERSION_URL="$convex_url/version" node -e \
    "fetch(process.env.CONVEX_VERSION_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

built_for="$(cat /app/convex/image 2>/dev/null || true)"
if [ -n "${CONVEX_BACKEND_IMAGE:-}" ] && [ -n "$built_for" ] && [ "$CONVEX_BACKEND_IMAGE" != "$built_for" ]; then
  log "warning: this image was built for the Convex backend $built_for, but compose.yaml runs"
  log "$CONVEX_BACKEND_IMAGE; use the compose.yaml of the release the image comes from"
fi

log "waiting for Convex at $convex_url"
for _ in $(seq 1 120); do
  convex_up && break
  sleep 1
done
convex_up || { log "Convex did not answer at $convex_url"; exit 1; }

instance_name="${CONVEX_INSTANCE_NAME:-$(cat "$credentials/instance_name" 2>/dev/null || echo convex-self-hosted)}"
instance_secret="${CONVEX_INSTANCE_SECRET:-$(cat "$credentials/instance_secret" 2>/dev/null || true)}"
if [ -z "$instance_secret" ]; then
  log "no Convex instance secret: mount the backend's credentials at $credentials or set CONVEX_INSTANCE_SECRET"
  exit 1
fi
admin_key="$(/app/convex/generate_key "$instance_name" "$instance_secret" | tail -n 1)"
unset instance_secret CONVEX_INSTANCE_SECRET

export CONVEX_SELF_HOSTED_URL="$convex_url"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$admin_key"
cd /app/backend
convex() { node node_modules/convex/bin/main.js "$@"; }

# One backup per target version: $data/version changes only after a deploy succeeds, and a deploy
# that keeps failing must not export everything again on every restart.
if [ -s "$data/version" ] && [ "$(cat "$data/version")" != "$version" ] &&
  [ "$(cat "$data/upgrade-backup" 2>/dev/null)" != "$version" ]; then
  stamp="$(date -u +%Y-%m-%dT%H-%M-%S-000Z)"
  backup="$data/backups/movies-manual-$stamp.zip"
  log "upgrading from $(cat "$data/version") to $version; backing up to $backup first"
  convex export --include-file-storage --path "$data/backups/.partial-movies-manual-$stamp.zip"
  mv "$data/backups/.partial-movies-manual-$stamp.zip" "$backup"
  chown movies:movies "$backup"
  printf '%s\n' "$version" >"$data/upgrade-backup"
fi

log "deploying the Convex functions ($version)"
convex deploy --yes --codegen disable --typecheck disable

log "configuring the deployment"
# Prints MEDIA_SERVICE_API_KEY=... and PLAYBACK_TOKEN_SECRET=...; keeps existing secrets.
media_env="$(node scripts/configure.ts "--site-url=$public_url" "--media-url=$public_url")"
media_service_api_key="$(sed -n 's/^MEDIA_SERVICE_API_KEY=//p' <<<"$media_env")"
playback_token_secret="$(sed -n 's/^PLAYBACK_TOKEN_SECRET=//p' <<<"$media_env")"
unset media_env

umask 022
install -d -m 755 /run/movies
node /app/media/scripts/configure-web.ts --from /app/web --to /run/movies/web \
  --convex-url "$convex_public_url"

printf '%s\n' "$version" >"$data/version"
# Deployed: the next upgrade, even to a version that failed before, backs up again.
rm -f "$data/upgrade-backup"

# The service's environment, readable by the media user only. Node parses it (`--env-file`), so
# secrets never appear in a command line. Unset optional settings stay out of it.
env_file=/run/movies/media.env
install -m 600 -o movies -g movies /dev/null "$env_file"
setting() { [ -z "$2" ] || printf '%s=%s\n' "$1" "$2" >>"$env_file"; }
setting PORT 8080
setting MEDIA_BASE_URL "$public_url"
setting CONVEX_URL "$convex_url"
setting CONVEX_PUBLIC_URL "$convex_public_url"
setting MEDIA_SERVICE_API_KEY "$media_service_api_key"
setting PLAYBACK_TOKEN_SECRET "$playback_token_secret"
setting CONVEX_SELF_HOSTED_ADMIN_KEY "$admin_key"
setting CONVEX_BACKEND_DIR /app/backend
setting DATA_DIR "$data/media"
setting BACKUP_DIR "$data/backups"
setting TRANSCODE_DIR /transcode
setting WEB_DIST_DIR /run/movies/web
setting LIBRARY_ROOTS "${LIBRARY_ROOTS:-/media}"
# The media service's optional settings, passed on when set (apps/media/README.md). Every one is
# in compose.yaml and .env.example too; scripts/check-deploy.sh keeps them in step.
optional_settings=(
  BACKUP_RETENTION_DAYS
  TMDB_API_KEY
  OTEL_EXPORTER_OTLP_ENDPOINT
  HARDWARE_ACCELERATION
  QSV_DEVICE
  LIBVA_DRIVER_NAME
  MAX_CONCURRENT_TRANSCODES
  STREAM_IDLE_SECONDS
  STREAM_BUFFER_AHEAD_SECONDS
  MIN_FREE_TRANSCODE_MB
  LIBRARY_RECONCILE_MINUTES
)
for name in "${optional_settings[@]}"; do
  setting "$name" "${!name:-}"
done
unset admin_key media_service_api_key playback_token_secret CONVEX_SELF_HOSTED_ADMIN_KEY TMDB_API_KEY

log "starting the media service at $public_url"
cd /app/media
exec setpriv --reuid=movies --regid=movies --init-groups --inh-caps=-all \
  env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production TZ="${TZ:-UTC}" \
  node --env-file="$env_file" --enable-source-maps dist/main.js
