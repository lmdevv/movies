#!/usr/bin/env bash
# Packaged-stack smoke test: builds the image, starts deploy/compose/compose.yaml on a fresh
# project with a generated fixture library mounted read-only, checks the install's privilege and
# secret boundaries, then runs apps/media/src/stack/packaged-stack.test.ts against it (sign-up,
# library, scan, direct and HLS playback, a media restart, CLI backup and restore).
#
#   scripts/stack-e2e.sh
#   IMAGE=ghcr.io/lmdevv/movies:main scripts/stack-e2e.sh   # skip the build
#
# Env: IMAGE, PROJECT (compose project, default movies-e2e), MOVIES_PORT (18080), CONVEX_PORT
# (18210), KEEP=1 to leave the stack running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="${PROJECT:-movies-e2e}"
movies_port="${MOVIES_PORT:-18080}"
convex_port="${CONVEX_PORT:-18210}"
image="${IMAGE:-}"

if [[ -z "$image" ]]; then
  image="movies:${project}"
  docker build -f "$root/deploy/compose/Dockerfile" -t "$image" "$root"
fi

library="$(mktemp -d)"
node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
# mktemp makes the folder private to this user; the media user (PUID) must read it, as it must
# read any real library.
chmod -R a+rX "$library"

export MOVIES_IMAGE="$image"
export MOVIES_LIBRARY="$library"
export MOVIES_PORT="$movies_port"
export CONVEX_PORT="$convex_port"
export MOVIES_PUBLIC_URL="http://127.0.0.1:${movies_port}"
export CONVEX_PUBLIC_URL="http://127.0.0.1:${convex_port}"
export PUID="$(id -u)" PGID="$(id -g)"
compose_args=(-p "$project" -f "$root/deploy/compose/compose.yaml")
compose() { docker compose "${compose_args[@]}" "$@"; }

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    compose logs --no-color --tail 80 movies convex >&2 || true
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$library"
  fi
  exit $status
}
trap cleanup EXIT

compose down --volumes --remove-orphans >/dev/null 2>&1 || true
compose up -d --pull missing --no-build

healthy() { curl -fsS "${MOVIES_PUBLIC_URL}/api/health" 2>/dev/null | grep -q '"backend":"connected"'; }
for _ in $(seq 1 120); do
  healthy && break
  sleep 2
done
healthy || { echo "the media service did not become healthy" >&2; exit 1; }

check() {
  if ! eval "$2"; then
    echo "check failed: $1" >&2
    exit 1
  fi
  echo "ok: $1"
}

in_movies() { compose exec -T movies "$@"; }
media_pid="$(in_movies sh -c 'for p in /proc/[0-9]*; do
  case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in node\ --env-file=*) echo "${p#/proc/}";; esac
done')"
media_uid="$(in_movies awk '/^Uid:/ { print $2 }' "/proc/${media_pid}/status")"

check "the media service runs unprivileged" '[[ -n "$media_pid" && "$media_uid" == "$PUID" && "$media_uid" != 0 ]]'
check "the service environment is private" \
  '[[ "$(in_movies stat -c "%u %a" /run/movies/media.env)" == "$PUID 600" ]]'
check "backups are private" '[[ "$(in_movies stat -c "%a" /data/backups)" == 700 ]]'
check "the library is read-only" '! in_movies setpriv --reuid=0 touch /media/library/written 2>/dev/null'
check "no secret is in the command line" \
  '! in_movies cat "/proc/${media_pid}/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
check "the admin key is not in the web app" \
  '! in_movies sh -c "grep -rqF \"\$(sed -n s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p /run/movies/media.env)\" /run/movies/web /app/web"'
check "Convex refuses admin calls without the key" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code}" "${CONVEX_PUBLIC_URL}/api/check_admin_key")" =~ ^40[13]$ ]]'

pnpm --dir "$root" --filter @movies/cli build >/dev/null

MOVIES_PACKAGED_STACK=1 \
  MOVIES_PACKAGED_CONVEX_URL="$CONVEX_PUBLIC_URL" \
  MOVIES_PACKAGED_MEDIA_URL="$MOVIES_PUBLIC_URL" \
  MOVIES_PACKAGED_LIBRARY=/media/library \
  MOVIES_PACKAGED_RESTART="docker compose ${compose_args[*]} restart movies" \
  pnpm --dir "$root" exec vitest run --root "$root" apps/media/src/stack/packaged-stack.test.ts

# An upgrade (another image version in /data/version) backs up before deploying the new functions.
archives() { in_movies sh -c 'ls /data/backups | grep -c "^movies-.*\.zip$"' || true; }
before="$(archives)"
in_movies sh -c 'echo 0.0.0-previous > /data/version'
compose restart movies >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "an upgrade backs up first" '[[ "$(archives)" -gt "$before" ]]'
check "the restarted service keeps its secrets" 'healthy'
