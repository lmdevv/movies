# [movies]

Self-hosted movies and TV for people and agents. Stream your own folders or NAS from one install,
with profiles, Netflix-style browsing, watching together at the same second, migration from
Jellyfin and Plex, and a CLI that can do everything the app can.

Early development. Nothing to install yet.

## Stack

- Convex for product state, auth, and live sync
- A Node + Effect HttpApi media service for scanning, direct play, HLS remux, and Intel QSV
  transcoding with ffmpeg
- A Vite + React + TanStack Router web app
- An Effect SDK and CLI with an agent skill
- Docker Compose or a NixOS module

## Development

```sh
nix develop
pnpm install
pnpm dev
```

See `AGENTS.md` for the layout, rules, and checks.

## License

MIT. The self-hosted Convex backend is FSL-1.1, converting to Apache-2.0 after two years.
