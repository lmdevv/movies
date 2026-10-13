#!/usr/bin/env bash
# Keeps the installs in step with each other and with the media service. Fails when:
#   - compose.yaml or the Dockerfile pins another Convex backend than deploy/convex-backend.image,
#     or the NixOS module or scripts/dev-stack.sh stops reading that file;
#   - a setting the media service reads (apps/media/src/media-config.ts) is neither set by the
#     container entrypoint nor passed on by it, or is missing from the NixOS module or
#     apps/media/README.md;
#   - a setting the entrypoint passes on is missing from compose.yaml, deploy/compose/.env.example,
#     the root .env.example, or the README's configuration table;
#   - the Jellyfin test image is referenced with different digests.
#
#   scripts/check-deploy.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

failures=0
fail() {
  echo "check-deploy: $*" >&2
  failures=$((failures + 1))
}

# --- The Convex backend image -------------------------------------------------------------------

pinned="$(<deploy/convex-backend.image)"
if ! [[ "$pinned" =~ ^ghcr\.io/get-convex/convex-backend:[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
  fail "deploy/convex-backend.image must hold one image reference with a digest; got '$pinned'"
fi

compose_image="$(sed -n 's/^ *image: \(ghcr\.io\/get-convex\/convex-backend:.*\)$/\1/p' deploy/compose/compose.yaml)"
[[ "$compose_image" == "$pinned" ]] ||
  fail "compose.yaml runs '$compose_image', not deploy/convex-backend.image ('$pinned')"

dockerfile_image="$(sed -n 's/^ARG CONVEX_IMAGE=//p' deploy/compose/Dockerfile)"
[[ "$dockerfile_image" == "$pinned" ]] ||
  fail "the Dockerfile copies generate_key from '$dockerfile_image', not '$pinned'"

grep -qF 'deploy/convex-backend.image' scripts/dev-stack.sh ||
  fail "scripts/dev-stack.sh no longer reads deploy/convex-backend.image"
grep -qF '../deploy/convex-backend.image' nix/module.nix ||
  fail "nix/module.nix no longer reads deploy/convex-backend.image"

# --- Media service settings ---------------------------------------------------------------------

# Every NAME in a Config call of the media service's configuration.
mapfile -t config_names < <(
  grep -oE 'Config\.[A-Za-z]+\([^)]*"[A-Z][A-Z0-9_]+"' apps/media/src/media-config.ts |
    grep -oE '"[A-Z][A-Z0-9_]+"' | tr -d '"' | sort -u
)
((${#config_names[@]} > 10)) || fail "found only ${#config_names[@]} settings in media-config.ts"

# Set by the entrypoint from the install's own layout and secrets.
mapfile -t entrypoint_set < <(sed -n 's/^setting \([A-Z][A-Z0-9_]*\) .*/\1/p' deploy/compose/entrypoint.sh | sort -u)
# Passed on from the container's environment when set.
mapfile -t entrypoint_forwarded < <(
  sed -n '/^optional_settings=(/,/^)/p' deploy/compose/entrypoint.sh | grep -oE '^ +[A-Z][A-Z0-9_]+' |
    tr -d ' ' | sort -u
)
((${#entrypoint_forwarded[@]} > 0)) || fail "found no optional_settings in entrypoint.sh"
# Fixed by the image: it listens on every interface inside the container and ships ffmpeg.
image_fixed=(HOST FFMPEG_PATH FFPROBE_PATH)

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

for name in "${config_names[@]}"; do
  if ! contains "$name" "${entrypoint_set[@]}" "${entrypoint_forwarded[@]}" "${image_fixed[@]}"; then
    fail "$name (media-config.ts) is neither set nor passed on by deploy/compose/entrypoint.sh"
  fi
  # An option-backed environment entry, or a secret the startup script writes to media.env.
  grep -qE "^ +${name} = |'${name}=%s" nix/module.nix || fail "$name (media-config.ts) is not set by nix/module.nix"
  grep -qF "\`${name}\`" apps/media/README.md || fail "$name (media-config.ts) is not in apps/media/README.md"
done

# What a Compose user sets: the passed-on settings plus LIBRARY_ROOTS, which has a container default.
user_facing=(LIBRARY_ROOTS "${entrypoint_forwarded[@]}")
for name in "${user_facing[@]}"; do
  grep -qE "^      ${name}: \\$\\{${name}:-\\}$" deploy/compose/compose.yaml ||
    fail "$name is passed on by the entrypoint but compose.yaml lacks '${name}: \${${name}:-}'"
  grep -qE "^${name}=" deploy/compose/.env.example || fail "$name is not in deploy/compose/.env.example"
  grep -qE "^${name}=" .env.example || fail "$name is not in .env.example"
  grep -qF "\`${name}\`" README.md || fail "$name is not in README.md's configuration table"
done

# --- Test images --------------------------------------------------------------------------------

mapfile -t jellyfin_refs < <(
  git ls-files -z | xargs -0 grep -ohE 'jellyfin/jellyfin:[0-9.]+(@sha256:[0-9a-f]{64})?' 2>/dev/null | sort -u
)
mapfile -t jellyfin_digests < <(printf '%s\n' "${jellyfin_refs[@]}" | grep -oE '@sha256:[0-9a-f]{64}' | sort -u)
if ((${#jellyfin_digests[@]} > 1)); then
  fail "the Jellyfin test image is pinned to different digests: ${jellyfin_digests[*]}"
fi

if ((failures > 0)); then
  exit 1
fi
echo "check-deploy: ok (${#config_names[@]} media settings, Convex backend $pinned)"
