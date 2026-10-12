# @movies/cli

The `movies` command: every registry command for people and agents, JSON on stdout by default,
`--human` for tables, and stable exit codes. Built on `@movies/sdk` over HTTP. The agent skill
lives in `skills/movies/SKILL.md`; its command reference is generated from the registry.

```sh
pnpm --filter @movies/cli build             # dist/movies.js, a single executable bundle
node apps/cli/dist/movies.js --help
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

The CLI parses argv with `node:util` rather than `effect/cli`, which is an unstable module the
repo's lint rejects; command handlers are Effect programs over the SDK.
