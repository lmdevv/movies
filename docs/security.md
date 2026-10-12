# Security review

The MVP's security review before its first release (2026-10-12, branch `w5-qa`). It covers the
Convex backend, the media service, the web app, the CLI, and the two installs, against the
"Reliability and security" section of the architecture and the decisions in `docs/decisions.md`.
Each finding says what was wrong, how it was fixed or why it stays, and where the evidence is.

## Threat model

- One household, self-hosted on a LAN or a tailnet. Both ports listen on `127.0.0.1` by default
  and must not face the internet (`docs/operations.md`).
- Attackers considered: a stranger who can reach the ports, a signed-in member probing for more
  than their account allows, a child on a shared browser or TV trying to leave a kids profile, a
  leaked or over-scoped API key, a hostile Jellyfin or Plex server during migration, crafted files
  in a library (names, links, NFO, media that targets ffmpeg), and someone who reads logs,
  telemetry, a backup, or the web bundle.
- Out of scope: a compromised host or Docker daemon, anyone holding the Convex admin key (it is
  root for the data), and network attackers between devices (plain HTTP; use a tailnet).

## Findings fixed in this review

| #   | Severity   | Finding                                                                                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High       | The media service read request bodies whole with no limit (Effect's default), before any check. A few large POSTs to `/api/playback/negotiate`, which needs no sign-in, exhausted its memory.                                                                                                                                                     | A global middleware refuses bodies over 128 KiB (413) and chunked bodies (411); Node's parser enforces the declared length.                                                                                                                                                                                    | `apps/media/src/http/hardening.ts`, `hardening.test.ts`                                                                          |
| 2   | Medium     | Parental controls could be undone from the kids profile. PIN unlocks lasted the whole 30-day session, so after a parent entered their PIN once on the family browser, anyone could pick that profile. A kids profile on the owner's browser could also turn its own limits off, create an open profile, mint keys, or re-rate titles as an admin. | A password session withholds `account`, `manage`, and `admin` while the account has a limited profile, every unrestricted profile has a PIN, and none is unlocked on the session. The web app locks the profile it switches away from. The operator can clear a forgotten PIN (`maintenance:clearProfilePin`). | `packages/backend/convex/lib/viewer.ts`; stack test "keeps a kids profile from lifting its limits"; checked in a browser (below) |
| 3   | Medium     | The web app was served without a content security policy or hardening headers, with an inline script, while its Convex tokens live in `localStorage`, so any XSS would steal sessions.                                                                                                                                                            | Every response carries a CSP (`script-src 'self'`, connections only to this origin and `CONVEX_PUBLIC_URL`, `frame-ancestors 'none'`, `object-src 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, and a Permissions-Policy. The theme script moved to `public/theme.js`.   | `hardening.test.ts`; the built app ran under the policy with no violations                                                       |
| 4   | Medium     | ffmpeg and ffprobe inherited the service's whole environment, including `CONVEX_SELF_HOSTED_ADMIN_KEY`, `MEDIA_SERVICE_API_KEY`, and `PLAYBACK_TOKEN_SECRET`. A media file that exploits a decoder would get the database.                                                                                                                        | The tools run with `PATH`, locale, `TZ`, and the VA-API and oneVPL paths only.                                                                                                                                                                                                                                 | `apps/media/src/media/media-tools.test.ts` runs `env` in place of ffprobe                                                        |
| 5   | Medium     | One member could exhaust the server: `playback.createSession` took any device ID, remux and audio-only streams had no limit, and a remux ran ffmpeg at disk speed to the end of the file, so every play wrote most of its file into `TRANSCODE_DIR` within minutes (this also threatened ordinary 4K remuxes).                                    | ffmpeg pauses (`SIGSTOP`) once it is `STREAM_BUFFER_AHEAD_SECONDS` (120) ahead of the player and continues when the player catches up. An account plays on at most eight devices; a ninth ends the quietest.                                                                                                   | `apps/media/src/playback/stream-throttle.test.ts`; stack test "keeps an account to eight playing devices"                        |
| 6   | Low–Medium | Signing out did not end the session's playback; the idle sweep ended it up to five minutes later, and the media service kept serving its streams until then.                                                                                                                                                                                      | `auth:signOut` is ours: it removes the session and its refresh tokens like Convex Auth's and ends its playback in the same mutation.                                                                                                                                                                           | Stack test "ends a session's playback when it signs out"                                                                         |
| 7   | Low–Medium | `FileResolverUnavailable` sent the underlying error to the client, including the absolute path of the file (`FileSystem.stat (/mnt/nas/Movies/…): EACCES`).                                                                                                                                                                                       | The error carries a fixed reason; the full error goes to the log.                                                                                                                                                                                                                                              | `apps/media/src/convex/convex-file-resolver.ts`                                                                                  |
| 8   | Low        | Outgoing requests followed redirects without re-checking the host, so the `image.tmdb.org` allowlist and the migration plugins' host guard could be walked to another host (SSRF), and a Plex token could follow a redirect.                                                                                                                      | The service's HTTP client never follows redirects; a redirect is an unsuccessful response.                                                                                                                                                                                                                     | `apps/media/src/http/outbound.test.ts`                                                                                           |
| 9   | Low        | `mediaService:endedSessions` paged by `endedAt` with a strict cursor and 200 rows, so sessions sharing one millisecond past the 200th (a restore, a sign-out of a busy account) were never stopped and their tokens kept working for up to six hours.                                                                                             | A page never splits one `endedAt`.                                                                                                                                                                                                                                                                             | Stack test "reports every session a sign-out ended, even past a page's limit"                                                    |
| 10  | Low        | The scanner read an NFO that linked outside the library root and used it as the title's metadata.                                                                                                                                                                                                                                                 | NFO files are read only when their real path stays inside the root.                                                                                                                                                                                                                                            | `library-scanner.test.ts` (fails without the fix with "Leaked Title")                                                            |
| 11  | Low        | Playback checked a file's real path against `LIBRARY_ROOTS` and then opened the original path, so a link swapped in between could redirect ffmpeg.                                                                                                                                                                                                | Playback opens the canonical path it checked.                                                                                                                                                                                                                                                                  | `apps/media/src/playback/file-resolver.ts`                                                                                       |
| 12  | Low        | `playback.renewToken` renewed a token without checking access again, so a revoked library grant, a lowered rating limit, or a re-locked PIN profile still got six more hours.                                                                                                                                                                     | Renewal checks the profile, its unlock, its limits, and the library grant.                                                                                                                                                                                                                                     | Stack test "stops renewing a token once the profile may no longer see the title"                                                 |

## Verified without changes

- **Every public Convex function enforces its scope.** `packages/backend/test/stack.test.ts`
  ("every public function") finds the modules from `convex/_generated/api.d.ts`, loads every
  export the runtime registered as public, generates valid arguments (real IDs from the
  deployment), and calls each one anonymously, as the media service, as a member, and with a
  read-only API key. Only `setup:status`, `invites:lookup`, `deviceAuth:status`, `deviceAuth:request`
  and Convex Auth's entry points answer anonymous callers; every other call outside the registry's
  scope is refused with `unauthenticated` or `forbidden`. Deleting one `authorize` call
  (`jobs:list`) makes four of these tests fail.
- **The media service key and user sessions stay apart:** the service account's grant holds only
  `media-service`, which no user function accepts; `mediaService:*` and `migrationService:*` all
  require it (same test).
- **Restricted keys cannot escalate:** API keys never hold `account`, cannot exceed the creating
  session, and lose `manage`/`admin` when the role is demoted; device approvals grant a subset of
  the approver's scopes; `media-service` is never grantable (existing stack tests "API keys",
  "device sign-in", "account administration").
- **Revocation ends derived sessions:** revoking a key, a session, or disabling an account ends its
  tokens on the next call and its playback sessions at once; the media service follows
  `endedSessions` and refuses ended sessions with `PlaybackSessionEnded`.
- **Profile ownership, kids ratings, library grants, host-only room control** (existing stack tests
  "profiles", "library access", "watch rooms").
- **Path traversal:** the web app's static route resolves inside `WEB_DIST_DIR` after links; HLS
  file names are `init.mp4` or `\d+.m4s` inside the stream's own folder; restore names must match
  `^[^./\\][^/\\]*\.zip$` and resolve inside `BACKUP_DIR`; the scanner follows links only inside
  the root and visits loops once; playback, sidecar subtitles, and local artwork are re-checked
  against `LIBRARY_ROOTS` on use.
- **Playback tokens:** constant-time HMAC verification, then audience and expiry; every media route
  verifies the token, and every stream lookup requires the token's session and file to match, so a
  token for one file or session cannot reach another's stream.
- **Artwork keys** are AES-256-GCM sealings under a key derived from `PLAYBACK_TOKEN_SECRET`; `?w=`
  takes a fixed list; cache names are hashes.
- **No user-supplied ffmpeg arguments or paths:** every spawn is built from server-side state; the
  audio track must match a probed track, the start offset is clamped, and nothing runs in a shell.
- **Media command routes** check the bearer token with `account.viewer` before reading the body and
  require the command's scope (`manage` for metadata search; `admin` for restore and migration).
- **Secrets:** the built web bundle holds no service key, playback secret, admin key, or JWT key
  (searched `apps/web/dist` for each value); logs and OTLP exports are redacted
  (`observability.test.ts`); backups are `0600` in a `0700` folder; the CLI config is `0600` in a
  `0700` folder, and an environment-only API key is never written to it.
- **Sign-in rate limiting:** Convex Auth refuses an account's password sign-ins with `rate_limited`
  after ten failures, even with the right password, for a while (tried against the dev stack).

## Accepted, with reasons

- **CORS allows any origin** on the media service. Every call carries an explicit bearer or
  playback token and nothing uses cookies, so another site gains no ambient authority; a fixed
  list would break a separately hosted web app. `/api/health` (stream count, acceleration mode) is
  readable by anyone who can reach the port.
- **Six-hour playback tokens** are verified offline; while the media service is disconnected from
  Convex it cannot learn of revocations (documented in the architecture).
- **No rate limiting in the media service.** Tokens are 256-bit HMACs, so guessing is not the risk;
  the body cap, per-account device limit, transcode limit, and throttling bound the cost of abuse.
- **Lockouts can be triggered by others:** ten wrong passwords lock that account's password sign-in
  for a while, and five wrong PINs lock a profile for five minutes (about 60 guesses an hour
  against a four-digit PIN, enough for parental controls, not for secrets).
- **Device sign-in:** at most 50 codes may wait at once, so an anonymous caller can block new device
  sign-ins for ten minutes; `deviceAuth.insert` reads every waiting code, so simultaneous requests
  conflict and retry (seen under parallel E2E load). User codes have about 34 bits and only matter
  to a signed-in approver. Device-code phishing is inherent to the flow; the approval page names
  the client and grants `read` and `play` unless the approver adds more.
- **`MEDIA_SERVICE_API_KEY` is a Convex deployment variable** (so `configure.ts` can reuse it), which
  means the Convex admin key can read it and therefore open stored migration credentials. The admin
  key already controls all data; exports do not include deployment variables.
- **Segments behind the player stay until the stream closes,** so a stream watched to the end still
  holds about its file's size in `TRANSCODE_DIR`, and free space is checked only when a stream
  starts. Size `TRANSCODE_DIR` for the largest remux you play.
- **Artwork downloads** from `image.tmdb.org` have no size cap, interrupted downloads can leave
  `.part` files, and first-time subtitle conversions and keyframe scans are not de-duplicated.
- **Registering a library folder** starts a recursive file watch before the folder's first scan
  checks it against `LIBRARY_ROOTS`; only `manage` sessions can do this, and the scan then fails.
- **Profile management on a shared browser** still lets anyone on an adult profile change the
  account; a kids profile cannot.
- **Dependency audit** (`pnpm audit --prod`): one high, `braces` ≤ 3.0.3 (stack exhaustion on
  deeply nested glob patterns), reached only through the `shadcn` CLI's globbing at development
  time; no patched release exists. Nothing else.

## How to repeat this review

```sh
scripts/dev-stack.sh destroy && scripts/dev-stack.sh up
pnpm --filter @movies/backend test:stack   # includes the every-public-function check
pnpm test                                    # hardening, outbound, media tools, throttle, scanner
pnpm audit --prod
VITE_CONVEX_URL=http://127.0.0.1:13200 pnpm --filter web build && grep -rlF "<secret value>" apps/web/dist
curl -sI http://127.0.0.1:<media-port>/      # security headers
```
