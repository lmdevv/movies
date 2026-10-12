# [movies]

MIT-licensed, agent-first, self-hosted movie and TV platform. It streams the user's own folders or
NAS shares with reactive playback, shared watching, and full Jellyfin and Plex migration. The
product name is `[movies]`, brackets included; the repo and packages use `movies`.

- Plan: [Linear project](https://linear.app/adsfsd/project/movies-b7a377940443). It holds the
  overview, stack, architecture, and design summary.
- MVP: media service, web app, SDK, and CLI with an agent skill. Native mobile and TV apps are V1.

## Rules

- **Copyleft code is read-only.** Jellyfin (GPL-2.0), Silo (AGPL-3.0), Kyoo (GPL-3.0), Wholphin
  (GPL) and Streamyfin (MPL-2.0) may be read for ideas and edge cases. Never copy, port, or
  translate their code into this repo. SyncLounge and stremio-core are MIT and may be reused with
  attribution. Effect, T3 Code and OpenCode are MIT and safe to reference.
- **Load the `coding-standards` skill** before writing, reviewing, or refactoring TypeScript. It is
  in `.agents/skills/coding-standards/`.
- **Effect 4 reference.** `effect` is pinned in `pnpm-workspace.yaml`. Keep a read-only clone of
  the matching `Effect-TS/effect-smol` tag in `.repos/effect-smol` (gitignored) and read its
  `LLMS.md` before writing Effect code. Do not import from or edit it.
- **Convex functions stay plain TypeScript** with `v` validators. Effect lives in the media
  service, contracts, SDK, and CLI.
- **No MCP server.** Agents use the CLI and `apps/cli/skills/movies/SKILL.md`.
- **Never commit secret values.** `.env.example` lists configuration names only.
- **Never weaken a lint rule, add a cast, or add a suppression to pass checks.** Fix the code or
  report the finding. Casts other than `as const` need a `// SAFETY:` comment.
- **No module mocks.** Test through real seams.

## Layout

| Path                 | Role                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `apps/web`           | Vite + React + TanStack Router SPA                                |
| `apps/media`         | Node + Effect HttpApi media service; serves the built SPA         |
| `apps/cli`           | Effect CLI with JSON output; agent skill in `skills/movies/`      |
| `packages/backend`   | Convex schema, functions, and Convex Auth                         |
| `packages/contracts` | Effect Schema DTOs, errors, media HttpApi, plugin role interfaces |
| `packages/sdk`       | Effect core with `/effect`, `/react`, `/promise` entry points     |
| `packages/ui`        | shadcn components restyled through Paper tokens                   |
| `packages/config`    | Shared strict `tsconfig`                                          |
| `deploy/compose`     | Docker Compose: Convex backend plus media/web                     |
| `nix/`               | NixOS module                                                      |

Ownership: Convex owns accounts, profiles, grants, libraries, titles, files, jobs, watch history,
and playback sessions. Disk owns original media, which is read-only. The media service owns
per-device streams, ffmpeg processes, and temporary segments. Convex never calls the media
service; the media service signs in with a restricted credential and subscribes outward.

The SDK core has no Node filesystem or DOM imports. Media and backend modules must never reach
browser bundles.

## Commands

```sh
nix develop          # Node 24, pnpm, ffmpeg
pnpm install         # also patches tsc and Oxlint with Effect diagnostics, installs lefthook
pnpm dev             # web on :3001 and Convex dev
pnpm typecheck       # tsc 7 with the Effect language service
pnpm lint            # Oxlint, type-aware, anti-slop and Effect rules
pnpm fmt:check       # Oxfmt
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm knip            # unused files, exports, and dependencies
```

`typecheck`, `lint`, `fmt:check`, and `test` run in the lefthook pre-commit hook and in CI. All
four must pass before every commit.

For local Convex without an account: `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev` in
`packages/backend`. Commit the regenerated `convex/_generated/`. Each worktree gets its own Convex
deployment, ports, service credential, and temporary output directory.

## Design

Build UI from the Paper file `[movies]` (ID `01M4PMRM5T60Q4P0YYZ8DY580D`) through the Paper MCP.
Paper Desktop must be running.

- Paper is the source of truth. Read structure with `get_tree_summary` and `get_jsx`, exact values
  with `get_computed_styles`, and the target with `get_screenshot`. Never read colors or sizes from
  screenshots.
- Tokens live in `packages/ui/src/styles/globals.css` under their Paper names. Re-export them with
  `get_tokens` in `tailwind` format when the design changes. Dark is the default theme and maps
  each `--color-dark-*` token onto its light role inside `.dark`.
- Use tokens for every color, size, and font. No raw values in components.
- Netflix look on web, the Apple TV app look on iOS, Netflix red in both modes.
- Content rules: no tips or filler copy, no CLI hints in the UI, no colored left stripes, and
  whitespace over bordered cards. One "Search ⌘K" field opens the command menu.
- Follow the design handoff note in the owner's vault (`projects/movies/movies Design.md`): flows,
  artboard map, decisions, and open questions. If code must differ from Paper, flag it instead of
  drifting.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
