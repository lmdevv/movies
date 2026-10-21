#!/bin/sh
# The image's `movies` CLI: `docker compose exec movies movies login`. It talks to this stack's own
# Convex and media service, and keeps its login in the data volume so it lasts across upgrades.
# Set any of these variables on the exec to override them.
export MOVIES_CONVEX_URL="${MOVIES_CONVEX_URL:-http://convex:3210}"
export MOVIES_MEDIA_URL="${MOVIES_MEDIA_URL:-http://127.0.0.1:8080}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/config}"
exec node /app/cli/movies.js "$@"
