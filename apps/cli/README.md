# @movies/cli

`movies`, the command line for [[movies]](https://github.com/lmdevv/movies), a self-hosted movie
and TV server. It runs every action the app has: search, play, progress, watch rooms, profiles,
libraries, scans, API keys, invites, Jellyfin and Plex migration, backups, and restores. Output is
JSON on stdout by default, `--human` prints tables, and exit codes are stable, so people and agents
use the same commands.

```sh
npm install -g @movies/cli      # Node 22 or newer
movies login --server http://nas.tailnet.ts.net:3210 --media-url http://nas.tailnet.ts.net:8080
movies search alien
movies play "Alien" --open      # mpv; without --open, prints the stream URL
movies --help
```

The server URL is the install's Convex URL (port 3210) and the media URL its web address (port
8080). `MOVIES_CONVEX_URL`, `MOVIES_MEDIA_URL`, `MOVIES_API_KEY`, and `MOVIES_PROFILE` override the
stored configuration. `movies login` without `--email` prints a code to approve in the web app;
agents use an API key from Settings → API keys (`movies login --api-key`, or `MOVIES_API_KEY`).

The agent skill ships in the package at `skills/movies/SKILL.md`. The CLI's version matches the
server release it belongs to. Other ways to install it, including standalone binaries, Nix, and
the server's own copy, are in the
[project README](https://github.com/lmdevv/movies#cli).

## Development

```sh
pnpm --filter @movies/cli build             # dist/movies.js, a single executable bundle
node apps/cli/dist/movies.js --help
pnpm --filter @movies/cli build:sea         # dist/sea/movies-<os>-<arch>, a standalone binary
pnpm --filter @movies/cli skill:reference   # regenerate the skill's command reference
pnpm --filter @movies/cli test:stack        # the built binary against scripts/dev-stack.sh
```

- `src/cli.ts` routes argv to a shortcut or a registry command (`movies <group> <action>`, or
  `movies call <name>`), prints results, and maps failures to exit codes (`src/cli-errors.ts`).
- `src/flags.ts` derives flags from each command's argument schema; `--json '<object>'` passes the
  whole argument object. `--profile-id` and `--device-id` default from the config.
- `src/config.ts` keeps profiles (server, device ID, viewing profile, API key, session) in
  `$XDG_CONFIG_HOME/movies/config.json` with mode 0600; `MOVIES_*` variables override it.
- Shortcuts: `account-commands.ts` (login, logout, whoami, profiles use, keys),
  `watch-commands.ts` (search, play, progress, continue), `room-commands.ts`, and
  `admin-commands.ts` (scan, import, backup, restore).
- The bundle inlines the workspace packages and every dependency, so the published package has no
  runtime dependencies. Releases publish it from `.github/workflows/release.yml`
  ([docs/operations.md](https://github.com/lmdevv/movies/blob/main/docs/operations.md#releasing)).

The CLI parses argv with `node:util` rather than `effect/cli`, which is an unstable module the
repo's lint rejects; command handlers are Effect programs over the SDK.
