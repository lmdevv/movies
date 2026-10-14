---
name: movies
description: Control a [movies] server (the user's self-hosted movie and TV library) from the terminal with the `movies` CLI. Use when asked to find, play, or track movies and shows, run watch rooms, manage profiles, libraries, scans, API keys, devices, invites, and accounts, or migrate from Jellyfin or Plex, back up, or restore a [movies] server.
---

# [movies] CLI

`movies` runs every action the [movies] app has. Each one is a command in a shared registry, so
the CLI, the web app, and this skill always agree. Output is JSON by default.

## Setup

The server URL is the install's Convex URL (`CONVEX_PUBLIC_URL`; port 3210 on the Compose and
NixOS installs, such as `http://nas.tailnet.ts.net:3210`); the media service URL is the web
address (`MOVIES_PUBLIC_URL`, port 8080).

- **API key (agents, CI):** create one in the web app (Settings → API keys) or with
  `movies keys create agent --scopes read,play` from a signed-in machine. The secret is shown once.

  ```sh
  movies login --server http://nas.tailnet.ts.net:3210 --media-url http://nas.tailnet.ts.net:8080 --api-key mk_...
  movies whoami
  ```

  Or set `MOVIES_CONVEX_URL`, `MOVIES_MEDIA_URL`, and `MOVIES_API_KEY` instead of logging in, so
  the key never touches the disk. Then choose the viewing profile once with
  `movies profiles list` and `movies profiles use <name>`; the config file keeps that choice and
  the server URL, never the key.

- **Device login (people):** `movies login --server <url>` prints a short code and an approval URL
  (and a QR code with `--human`), then waits until someone approves it in the web app. In JSON mode
  the first stderr line is `{"event":"device_code","userCode","verificationUrl","expiresAt"}`;
  relay the code and URL to the user, then wait for the command to exit.
- **Password:** `movies login --server <url> --email you@example.com --password`, with the
  password piped on stdin or in `MOVIES_PASSWORD`.

`login` stores the server, this install's device ID, the session, and the default viewing profile
in `$XDG_CONFIG_HOME/movies/config.json` (mode 0600). `--profile <name>` (or `MOVIES_PROFILE`)
selects another stored server. `movies logout` signs out and forgets the key and session.

## How it works

- `movies <group> <action> [flags]` runs registry command `<group>.<action>`; words are kebab-case
  (`movies api-keys create`, `movies history continue-watching`). `movies call <name> --json
  '{...}'` runs any command by its dotted name, including ones a shortcut replaces.
- Flags come from the argument schema: `titleId` is `--title-id`. When a command needs exactly one
  value it can go first without its flag: `movies titles get <title-id>`. Lists take repeated flags
  or commas (`--scopes read,play`). `--json '<object>'` passes the whole argument object; flags
  override its fields.
- `--profile-id` and `--device-id` default to the stored viewing profile and this install's
  device. Choose the profile with `movies profiles use <name-or-id>`.
- IDs are opaque strings from earlier results. Never invent them.
- Results print as JSON on stdout. Errors print on stderr as `{"error":{"code","message"}}`.
  `--human` (or `--format table`) prints tables and sentences instead.
- Commands that queue a job (scans, metadata refreshes, backups, migrations) return a `jobId` at
  once. Add `--wait` to follow it until it ends; progress goes to stderr and the output becomes
  `{ "result", "job" }`. `--timeout <seconds>` (default 3600) bounds the wait.
- `movies commands` lists every command with its flags and its arguments as JSON Schema;
  `movies <command> --help` shows one.
- Scopes limit what a session may do: `read`, `play`, `account`, `manage` (libraries, scans,
  metadata; admins), `admin` (users, invites, backups, migration; admins). A missing scope fails
  with `forbidden`.

## Recipes

Find something and play it in mpv or VLC:

```sh
movies search alien
movies play "Alien" --open           # launches mpv; without --open, prints .url
movies play "The Expanse" --human    # a show plays its next episode
movies continue                      # what to resume
movies progress "The Expanse"
```

Watch together (the host's device controls the room; guests follow):

```sh
movies rooms create "Alien" --position 0     # host → .id
movies rooms join <room-id>                  # guest, on another install or account
movies rooms play                            # host; acts on the room this device is in
movies rooms pause
movies rooms seek --position 1:02:30
movies rooms status --watch                  # one JSON line per change
movies rooms leave                           # a host leaving ends the room
```

A guest's `rooms play|pause|seek` fails with `forbidden`. A control racing another change is
retried once at the new revision.

Libraries and scans (admin):

```sh
movies libraries create --name Films --kind movies --roots /srv/films --wait
movies scan Films --mode quick --wait
movies jobs list --status running
```

Fix a wrong match (admin):

```sh
movies metadata search-candidates --title-id <title-id> --query "Alien" --year 1979
movies metadata fix-match --title-id <title-id> --provider tmdb --provider-id 348 --wait
```

Accounts and access:

```sh
movies keys create ci --scopes read,manage --expires-in-days 90   # .secret is shown once
movies keys list
movies keys revoke ci
movies invites create --role member --email friend@example.com    # share .url
movies device-auth approve --user-code ABCD-EFGH --scopes read,play
movies sessions list
```

Migrate from Jellyfin or Plex, back up, and restore (admin):

```sh
echo "$JELLYFIN_API_KEY" | movies import jellyfin --url http://jellyfin:8096 --dry-run
echo "$JELLYFIN_API_KEY" | movies import jellyfin --url http://jellyfin:8096 \
  --path-map /data/movies=/mnt/nas/movies --map <source-user-id>=<profile-id> --wait
echo "$PLEX_TOKEN" | movies import plex --url http://plex:32400 --dry-run
movies backup --wait
movies backups list
movies restore movies-2026-10-12.zip        # every session signs in again
```

`movies import` connects, dry-runs, and only then imports what that dry run planned. Read the
dry run's `users`: an `invite` user has no [movies] account yet, so import never creates one;
invite the person or `--map` them to a profile (`skip` leaves them out). A source folder maps on
its own when a `LIBRARY_ROOTS` folder ends in the same names (`/data/movies` to
`/mnt/nas/movies`); pass `--path-map` for the rest.
Media files are never moved or copied. Running the import again changes nothing already imported,
and newer [movies] progress is kept unless the source played the item more recently.

## Exit codes

| Code | Meaning                                                          | What to do                                      |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------- |
| 0    | Success                                                          |                                                 |
| 1    | Server or protocol failure, unreadable config, mpv missing       | Read `error.code` and `error.message`           |
| 2    | Usage: unknown command, missing flag, invalid argument           | Fix the command; see `movies <command> --help`  |
| 3    | Not logged in, session ended, credentials or login refused       | `movies login`, or a new API key                |
| 4    | Forbidden: missing scope, role, PIN unlock, or not the host      | Use a key with the scope, or ask an admin       |
| 5    | Not found (hidden titles also report this)                       | Check the ID; list again                        |
| 6    | Conflict or stale revision                                       | Read the state again and retry                  |
| 7    | Expired code, invite, or key                                     | Start over with a new one                       |
| 8    | Rate limited, or the media service is busy                       | Wait and retry                                  |
| 9    | Server unreachable                                               | Check the URLs; a mutation may still have run   |
| 10   | A job followed with `--wait` failed, was cancelled, or timed out | `movies jobs get <job-id>`                      |
| 11   | `movies import` could not use the Jellyfin or Plex server        | Read `error.code`, such as `source_auth_failed` |

## Troubleshooting

- `not_logged_in`: run `movies login`, or set `MOVIES_CONVEX_URL` and `MOVIES_API_KEY`.
- `unauthenticated` after it worked before: the key or session was revoked. A stored API key signs
  in again on its own; otherwise log in again.
- `unavailable`: the URL is wrong or the server is down. The server URL is the Convex URL.
- `No viewing profile`: run `movies profiles list` and `movies profiles use <name>`.
- `forbidden` on a PIN profile: `movies profiles unlock --pin <pin>` for this session first.
- A job stuck in `pending` means the media service is not running.
- A scan job that fails with `Library root not approved` names a folder outside the media
  service's `LIBRARY_ROOTS`; point the library at an approved folder (`movies libraries update`).
- `movies play` failures from the media service print `playback_<recovery>` codes:
  `playback_unsupported` (this player cannot play the file in any mode), `playback_retry_later`
  (exit 9: transcoders busy or the media service cannot reach its files right now),
  `playback_new_session` (the session ended; run `movies play` again), and `playback_fail`.

## Command reference

<!-- BEGIN:commands -->
<!-- Generated from the command registry by `pnpm --filter @movies/cli skill:reference`. Do not edit by hand. -->

### Shortcuts

- `movies login [--server <convex-url>] [--media-url <url>] [--api-key <key> | --email <email> --password]`: Sign in: device login by default (prints a code, a URL, and a QR code, then waits); --api-key or --email with --password (read from stdin or MOVIES_PASSWORD).
- `movies logout`: Sign out and forget the session.
- `movies whoami`: Show the account, session scopes, server, device, and default viewing profile.
- `movies profiles use <profile-id-or-name>`: Choose the viewing profile commands use when --profile-id is not given.
- `movies keys create <name> --scopes <read|play|manage|admin,...> [--expires-in-days <int>]`: Create an API key; the secret is printed once.
- `movies keys list`: List this account's API keys.
- `movies keys revoke <api-key-id-or-name>`: Revoke an API key and end every session it signed in.
- `movies search <query> [--limit <int>]`: Search titles on the default viewing profile.
- `movies play <title> [--episode-id <id>] [--from <seconds>] [--max-height <lines>] [--open]`: Start playback of a title ID or the best name match (a show resumes its next episode) and print the stream URL for mpv or VLC; --max-height caps the picture, such as 720 on a slow link (a taller source is transcoded down); --open launches mpv.
- `movies progress [<title>]`: Show a title's progress, or the recent watch history.
- `movies continue`: List what to resume and which episodes come next.
- `movies rooms create <title> [--episode-id <id>] [--position <seconds>]`: Start a watch room hosted by this device, paused at the position.
- `movies rooms join <room-id>`: Join a room on this device with the default viewing profile.
- `movies rooms play [<room-id>] [--position <seconds>]`: Host: play the room from its current position or --position.
- `movies rooms pause [<room-id>]`: Host: pause the room at its live position.
- `movies rooms seek [<room-id>] --position <seconds>`: Host: move the room to a position.
- `movies rooms leave [<room-id>]`: Leave the room; a host leaving ends it.
- `movies rooms status [<room-id>] [--watch]`: Show the room's clock, live position, and members; --watch prints every change.
- `movies scan [<library-id-or-name>] [--mode quick|full] [--wait [--timeout <seconds>]]`: Scan one library, or every library, for new, changed, and missing files.
- `movies import jellyfin|plex --url <server-url> [--user <jellyfin-admin>] [--path-map <source-folder>=<local-folder>,...] [--map <source-user-id>=<profile-id>|skip,...] [--dry-run] [--wait]`: Migrate libraries, watch history, favorites, collections, and metadata overrides; the token (or --user's password) is read from stdin, MOVIES_IMPORT_TOKEN, or MOVIES_IMPORT_PASSWORD.
- `movies backup [--wait [--timeout <seconds>]]`: Back up the database now.
- `movies restore <backup-file-or-id>`: Restore the database from a backup; every session signs in again.
- `movies commands [--markdown]`: List every command with its flags and argument JSON Schema.
- `movies call <command-name> [--json <object>]`: Run any registry command by its dotted name, such as rooms.pause.

### setup

- `movies setup status`: Show whether the server has an owner and a library yet. (no sign-in needed)

### account

- `movies account viewer`: Show the signed-in account and what this session may do. (any session)

### invites

- `movies invites lookup <code>`: Show an invite's state from its code. (no sign-in needed)
- `movies invites create [--email <text>] <admin|member> [--expires-in-days <int>]`: Invite someone to create an account. (scope admin)
- `movies invites list`: List invites. (scope admin)
- `movies invites revoke <invite-id>`: Revoke an open invite. (scope admin)

### users

- `movies users list`: List accounts. (scope admin)
- `movies users set-role --user-id <id> --role <admin|member>`: Make an account an admin or a member. (scope admin)
- `movies users disable <user-id>`: Disable an account and sign out all of its sessions. (scope admin)
- `movies users enable <user-id>`: Re-enable a disabled account. (scope admin)
- `movies users set-library-access --user-id <id> --library-ids <id,...>`: Choose which restricted libraries a member can see. (scope admin)

### keys

- `movies api-keys create --name <text> --scopes <read|play|manage|admin,...> [--expires-in-days <int>]`: Create a scoped API key; the secret is shown once. (scope account)
- `movies api-keys list [--user-id <id>]`: List API keys; admins may list another account's. (scope account)
- `movies api-keys revoke <api-key-id>`: Revoke an API key and end every session it signed in. (scope account)

### devices

- `movies device-auth request <client-name>`: Start a device sign-in and get a code to approve. (no sign-in needed)
- `movies device-auth status <device-code>`: Watch whether a device sign-in was approved. (no sign-in needed)
- `movies device-auth lookup <user-code>`: Show the device behind a sign-in code. (scope account)
- `movies device-auth approve --user-code <text> --scopes <read|play|account|manage|admin,...>`: Approve a device sign-in with chosen scopes. (scope account)
- `movies device-auth deny <user-code>`: Deny a device sign-in. (scope account)

### sessions

- `movies sessions list`: List signed-in browsers, devices, and API keys. (scope account)
- `movies sessions revoke <session-id>`: Sign out a session. (scope account)

### profiles

- `movies profiles list`: List this account's profiles. (scope read)
- `movies profiles create --name <text> --avatar <text> (--kids | --no-kids) [--max-age-rating <int>]`: Create a profile. (scope account)
- `movies profiles update [--profile-id <id>] [--name <text>] [--avatar <text>] [--kids | --no-kids] [--max-age-rating <int>]`: Rename a profile or change its avatar or rating limit. (scope account)
- `movies profiles remove [--profile-id <id>]`: Delete a profile with its history and list. (scope account)
- `movies profiles set-pin [--profile-id <id>] <pin>`: Set or clear a profile PIN. (scope account)
- `movies profiles unlock [--profile-id <id>] <pin>`: Unlock a PIN profile for this session. (scope read)
- `movies profiles lock [--profile-id <id>]`: Lock a PIN profile again on this session. (scope read)

### browse

- `movies titles home [--profile-id <id>]`: Show the home rows for a profile. (scope read)
- `movies titles list [--profile-id <id>] [--cursor <text>] [--limit <int>] [--kind <movie|show>] [--library-id <id>] [--sort <name|added|year>] [--genre <text>] [--year-from <int>] [--year-to <int>] [--studio <text>] [--min-rating <number>]`: List movies or shows. (scope read)
- `movies titles genres [--profile-id <id>] [--kind <movie|show>]`: List genres of the titles a profile may see, most common first. (scope read)
- `movies titles similar [--profile-id <id>] <title-id> [--limit <int>]`: Show titles like this one that a profile may see. (scope read)
- `movies titles search [--profile-id <id>] <query> [--limit <int>]`: Search titles by name. (scope read)
- `movies titles get [--profile-id <id>] <title-id>`: Show a movie or show. (scope read)
- `movies titles episodes [--profile-id <id>] --title-id <id> --season-number <int>`: List a season's episodes. (scope read)
- `movies libraries list`: List the libraries this account can see. (scope read)
- `movies collections list [--profile-id <id>] [--limit <int>]`: Show collections and the titles a profile may see in each. (scope read)
- `movies collections get [--profile-id <id>] <collection-id>`: Show a collection and the titles a profile may see in it. (scope read)
- `movies people get [--profile-id <id>] <person-id>`: Show a person and the titles a profile may see them in. (scope read)
- `movies people search [--profile-id <id>] <query> [--limit <int>]`: Search cast and crew by name. (scope read)
- `movies people request-details [--profile-id <id>] <person-id>`: Fetch a person's biography and dates if they are missing. (scope read)

### history

- `movies history continue-watching [--profile-id <id>]`: List what to resume and which episodes come next. (scope read)
- `movies history list [--profile-id <id>] [--cursor <text>] [--limit <int>]`: List a profile's watch history, most recent first. (scope read)
- `movies history mark-watched [--profile-id <id>] <title-id> [--episode-id <id>]`: Mark a movie, episode, or whole show watched. (scope play)
- `movies history mark-unwatched [--profile-id <id>] <title-id> [--episode-id <id>]`: Mark a movie, episode, or whole show unwatched. (scope play)
- `movies my-list list [--profile-id <id>]`: Show a profile's list. (scope read)
- `movies my-list add [--profile-id <id>] <title-id>`: Add a title to my list. (scope play)
- `movies my-list remove [--profile-id <id>] <title-id>`: Remove a title from my list. (scope play)

### playback

- `movies playback create-session [--profile-id <id>] [--device-id <id>] [--device-name <text>] <title-id> [--episode-id <id>] [--file-id <id>] [--room-id <id>]`: Start playing a movie or episode on this device. (scope play)
- `movies playback renew-token <session-id>`: Get a fresh playback token for an active session. (scope play)
- `movies playback report-progress --session-id <id> --position-ms <number> [--duration-ms <number>] --event <tick|pause|resume|seek|ended>`: Report this device's position. (scope play)
- `movies playback end-session --session-id <id> --position-ms <number>`: Stop playback on this device. (scope play)
- `movies playback next-episode [--profile-id <id>] <episode-id>`: Show the episode after this one. (scope read)
- `movies playback active`: List this account's active playback on every device. (scope read)

### rooms

- `movies call rooms.create --json <object>`: Start a watch room for what this device is playing. (scope play)
- `movies rooms get <room-id> [--profile-id <id>]`: Show a room's members and committed clock. (scope read)
- `movies rooms current [--device-id <id>]`: Show the room this device is in. (scope read)
- `movies call rooms.join --json <object>`: Join a room on this device. (scope play)
- `movies call rooms.leave --json <object>`: Leave a room; the host leaving ends it for everyone. (scope play)
- `movies call rooms.play --json <object>`: Play the room from the host's position. (scope play)
- `movies call rooms.pause --json <object>`: Pause the room at the host's position. (scope play)
- `movies call rooms.seek --json <object>`: Move the room to a position. (scope play)
- `movies rooms buffering --room-id <id> [--device-id <id>] --revision <int> --position-ms <number>`: Freeze the room while the host buffers. (scope play)
- `movies rooms heartbeat <room-id> [--device-id <id>] [--position-ms <number>] [--revision <int>] [--drift-ms <number>]`: Report this device is still in the room; the host also reports its position. (scope play)
- `movies rooms set-media --room-id <id> [--device-id <id>] --revision <int> --title-id <id> [--episode-id <id>] [--file-id <id>]`: Switch the room to another title or episode, paused at the start. (scope play)
- `movies rooms end <room-id> [--device-id <id>]`: End the room for everyone. (scope play)
- `movies rooms time`: Read the server clock to estimate this device's offset. (scope play)

### libraries

- `movies libraries list-details`: List every library with its folders and access. (scope manage)
- `movies libraries get <library-id>`: Show a library's folders and access. (scope manage)
- `movies libraries create --name <text> --kind <movies|shows|mixed> --roots <text,...> [--access <everyone|restricted>] [--wait [--timeout <seconds>]]`: Add a library folder and scan it. (scope manage; job: add `--wait`)
- `movies libraries update <library-id> [--name <text>] [--roots <text,...>] [--access <everyone|restricted>] [--trickplay | --no-trickplay]`: Rename a library or change its folders, access, or scrub thumbnails. (scope manage)
- `movies libraries remove <library-id>`: Remove a library from [movies]; files on disk are untouched. (scope manage)
- `movies libraries files <library-id> [--cursor <text>] [--limit <int>] [--filter <all|missing|unmatched>] [--title-id <id>]`: List a library's files with their titles, or only missing or unmatched ones. (scope manage)
- `movies libraries file-summary <library-id>`: Count a library's missing files and unmatched titles. (scope manage)
- `movies libraries scan <library-id> [--mode <full|quick>] [--wait [--timeout <seconds>]]`: Scan a library for new, changed, and missing files. (scope manage; job: add `--wait`)
- `movies libraries generate-trickplay <library-id>`: Generate scrub thumbnails for every file in a library that has none. (scope manage)

### jobs

- `movies jobs list [--kind <scan|metadata|person|backup|migration|trickplay>] [--status <pending|running|succeeded|failed|cancelled>] [--limit <int>]`: List recent background jobs. (scope manage)
- `movies jobs get <job-id>`: Show a background job's progress. (scope manage)
- `movies jobs cancel <job-id>`: Cancel a pending or running job. (scope manage)

### metadata

- `movies metadata search-candidates --title-id <id> --query <text> [--year <int>]`: Search the metadata provider for matches for a title. (scope manage)
- `movies metadata fix-match --title-id <id> --provider <tmdb> --provider-id <id> [--wait [--timeout <seconds>]]`: Match a title to a metadata provider entry. (scope manage; job: add `--wait`)
- `movies metadata refresh <title-id> [--wait [--timeout <seconds>]]`: Refresh a title's metadata from its current match. (scope manage; job: add `--wait`)
- `movies metadata edit <title-id> --set <json> [--clear <name|sortName|year|overview|certification|ageRating,...>]`: Override or clear a title's name, year, overview, or rating. (scope manage)

### backups

- `movies backups list`: List backups. (scope admin)
- `movies backups run [--wait [--timeout <seconds>]]`: Back up the database now. (scope admin; job: add `--wait`)
- `movies backups restore <backup-id>`: Restore the database from a backup; every session signs in again. (scope admin)

### migration

- `movies migration connect --source <jellyfin|plex> --url <text> --credentials <json> [--path-mappings <json>]`: Connect to a Jellyfin or Plex server to migrate from. (scope admin)
- `movies migration dry-run <connection-id> [--users <json>]`: Preview what a migration would import without writing anything. (scope admin)
- `movies migration import <connection-id> [--users <json>]`: Import libraries, watch history, favorites, collections, and metadata overrides. (scope admin)
- `movies migration status`: Show migration jobs, their phase, and what they imported. (scope admin)

<!-- END:commands -->
