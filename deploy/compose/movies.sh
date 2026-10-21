#!/bin/sh
# The image's `movies` CLI: `docker compose exec movies movies login`. It talks to this stack's own
# Convex and media service at their addresses inside the container, whatever the host publishes
# them on; the stream URLs `movies play` prints still use MOVIES_PUBLIC_URL. It keeps its login in
# the data volume so it lasts across upgrades. Set any of these variables on the exec to override
# them.
export MOVIES_CONVEX_URL="${MOVIES_CONVEX_URL:-$CONVEX_URL}"
export MOVIES_MEDIA_URL="${MOVIES_MEDIA_URL:-http://127.0.0.1:8080}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/config}"
exec node /app/cli/movies.mjs "$@"
