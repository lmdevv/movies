# Implementation decisions

Cross-package decisions that every client, the backend, and the media service build against.
The product architecture and design live in the owner's vault; this file records the concrete
choices made while implementing them. Update it in the same PR that changes a decision.

## Playback tokens

- Format: `v1.<payload>.<signature>`. `payload` is base64url (no padding) of UTF-8 JSON; the
  signature is base64url HMAC-SHA256 over the ASCII string `v1.<payload>` with the raw bytes of
  `PLAYBACK_TOKEN_SECRET` (a base64url string of at least 32 random bytes, decoded before use).
- Payload fields: `aud` (`"media"`), `sub` (user ID), `pid` (profile ID), `fid` (file ID), `sid`
  (playback session ID), `iat` and `exp` (milliseconds since the epoch). Lifetime six hours.
- Convex signs with WebCrypto in plain TypeScript. The media service verifies with the shared
  verifier in `@movies/contracts/playback-token` (constant time; a wrong audience, a bad or
  non-canonically encoded signature, or `exp <= now` is refused). Shared test vectors in
  `packages/contracts` keep both sides honest.
- A token whose playback session has ended is refused with `PlaybackSessionEnded` (410) even
  before it expires: the media service follows `mediaService:endedSessions`, stops the session's
  HLS streams, and remembers ended sessions for a token's lifetime (catching up on the last six
  hours at startup).
- Tokens never appear in logs. Media URLs carry the token in the `token` query parameter because
  `<video>` and HLS segment fetches cannot set headers.

## Identities, roles, and scopes

- A Convex Auth user is an account. Roles: `owner` (first account), `admin`, `member`, and
  `service` (the media service's system account, which has no password).
- Profiles belong to an account. A kids profile has a maximum age rating (default 7); any profile
  may have a maximum. Titles store a minimum age derived from their certification
  (`ageRatingFromCertification` in contracts); a limited profile never sees titles above its
  maximum or unrated titles, and asking for one directly reports `not_found`.
- Any profile may have a 4 to 8 digit PIN. Each session unlocks a PIN profile on its own
  (`profiles.unlock`); the unlock lives on the session row. Five wrong PINs in a row lock the
  profile for five minutes. Changing or deleting a PIN profile requires it to be unlocked. The web
  app locks a profile again (`profiles.lock`) when the browser switches to another one, so a PIN
  guards a profile every time someone picks it, not once per sign-in. The operator clears a
  forgotten PIN with `convex run maintenance:clearProfilePin '{"profileId":"…"}'`.
- A password session withholds `account`, `manage`, and `admin` while the account has a kids or
  rated profile, every unrestricted profile has a PIN, and none of them is unlocked on the
  session. Only then do PINs keep someone in a limited profile, and only then could that profile
  otherwise lift its own limits, add an open profile, mint keys, or re-rate titles. `account.viewer`
  reports the reduced scopes, so the web app hides those screens. API key and device sessions are
  exempt: whoever created them held those scopes.
- Sessions created by an API key or device sign-in carry a grant with explicit scopes, stored on
  the `authSessions` row itself. Effective scopes are the grant's scopes that the role still
  allows, so demoting an admin strips `manage` and `admin` from their keys and devices at once.
  Password sessions have no grant and hold every scope their role allows.
- Scopes: `read` (browse, search, history, room state, PIN unlock), `play` (playback sessions,
  progress, my list, watched marks, rooms), `account` (the account's own profiles, PINs, API keys,
  device approvals, and sessions), `manage` (libraries, scans, jobs other than backups and
  migrations, metadata fixes; admin role required), `admin` (users, invites, other people's keys, backups, restore, migration; admin role
  required), and `media-service`. `account` was added so a key or device can never mint
  credentials unless explicitly granted it; API keys can never hold it.
- API keys hold a non-empty subset of `read`, `play`, `manage`, `admin`, never more than the
  creating session holds. Device approvals grant a subset of the approving session's scopes and
  may include `account`. `media-service` is never grantable.
- The media service signs in with `MEDIA_SERVICE_API_KEY` through the `apikey` provider. The key
  belongs to the `service` account, is created by `packages/backend/scripts/configure.ts`, and its
  grant carries only `media-service`, which allows the media functions and nothing else.
- An API key's session ends at the key's expiry at the latest, and every call checks the key again:
  a revoked, deleted, or expired key ends its session at once. Admins manage other accounts' keys,
  except the owner's.
- Validators check shapes; the bounds the contracts put on arguments (display names 1 to 80
  characters, avatar keys 1 to 40, device IDs up to 128, folders up to 1024 and 20 per library,
  non-negative finite positions and durations) are checked again in `convex/lib/bounds.ts`, and the
  registry test compares each bound with its contract schema.
- Every public Convex function checks the viewer's scopes server-side, and checks the session row
  on every call: signing out, revoking a key, revoking a session, or disabling the account ends
  its tokens immediately and ends the playback sessions it started. `auth:signOut` is ours, not
  Convex Auth's: it removes the session and its refresh tokens as Convex Auth does and also ends
  the session's playback. Renewing a playback token checks the profile, its PIN unlock, its limits,
  and the library grant again. `packages/backend/test/stack.test.ts` calls every public function
  (found from `convex/_generated/api`) anonymously, as the media service, as a member, and with a
  read-only key, and expects each call outside the registry's scope to be refused.

## Command registry

- `@movies/contracts/commands` lists every user action once: name (dotted, such as
  `titles.list`), summary, group, kind (`query`, `mutation`, `action`, or `media` for media
  service HTTP calls), `scope` (a scope, `public` for anonymous calls, or `authenticated` for any
  session), Effect Schema args and result, and the Convex function it calls. The function path is
  the name with its dot replaced by a colon (`titles.list` calls `titles:list`); `media` commands
  name a `route` instead.
- Convex functions stay plain TypeScript with `v` validators and do not import
  `@movies/contracts`. `packages/backend/test/registry.test.ts` checks that each Convex command
  and media service function names an existing public function of the same kind whose argument and
  return validators describe the same wire values as the schemas, that every public function is
  listed, and that constants duplicated on both sides agree. ID schemas carry a `convexTable`
  annotation for this check.
- Expected failures travel as `ConvexError({ code, message })` with the codes in
  `@movies/contracts/errors`; the media service answers `media` commands with the same body.
- For `media` commands the SDK sends the caller's Convex auth token as a bearer token; the media
  service calls `account.viewer` with it (a one-shot HTTP call, so revoked sessions are refused at
  once) and checks the command's scope. Route groups register through `commandRoute` in
  `apps/media/src/http/command-routes.ts` and are listed once in `apps/media/src/main.ts`.
- The SDK, CLI, and command menu are generated from the registry.

## Media service and Convex

- Convex never calls the media service. The media service subscribes to its job and ended-session
  queries and calls `media-service` scoped mutations.
- Scan jobs use leases: a claim writes `leaseOwner` and `leaseExpiresAt`; the worker renews it, and
  an expired lease can be reclaimed after a restart. The media service claims with a 60 second
  lease, renews every 15 seconds with the scanner's counters as progress, and stops the job's work
  when a renewal reports it cancelled or the lease lost. Failures say whether to retry: a folder
  outside `LIBRARY_ROOTS` fails for good (`Library root not approved: …` on the job), an
  unreadable folder or an unreachable Convex returns the job to the queue. Scans and metadata
  writes are idempotent, so a job that runs twice is harmless.
- The media service signs in with `MEDIA_SERVICE_API_KEY` over the SDK's WebSocket transport and
  keeps retrying with capped exponential backoff (0.5 to 30 seconds, jittered) while Convex is
  down or refuses the key; a session that ends signs in again, and a call refused as
  `unauthenticated` is retried once after that.
- Scans: a `full` scan job re-reads every file; a `quick` one skips files whose size and
  modification time did not change; watchers and the periodic reconciliation are quick. Convex
  stores absolute paths. A title's match key is its kind plus a provider ID (`movie:tmdb:603`),
  else its normalized name and year (`show:local:fixture show (2021)`). Extras (trailers,
  featurettes) belong to no title and are not stored. A multi-episode file is stored under its
  first episode.
- The media service's functions are listed with their schemas in
  `@movies/contracts/media-service` (`mediaService:*`). It subscribes to `pendingJobs`,
  `libraries`, and `endedSessions`, resolves a token's file with `resolveFile`, and writes scans
  in batches of at most 100 with `upsertScanned` and `markMissing`. Missing files keep their
  records and history.
- Library folders are normalized (trimmed, no repeated or trailing slashes) and may not equal,
  contain, or sit inside another library's folder, nor nest within one library: a grant on one
  library must never expose another's files. A migration reuses the library whose folder holds,
  or lies inside, a folder it imports, and keeps only the outermost of nested source folders.
  Libraries made before this rule may still overlap; `convex run maintenance:overlappingLibraries`
  lists them.
- `titles.list` pages by index position (the sort value and creation time of the last title read)
  instead of Convex's cursor, so one query can read several batches: limited profiles and kind
  filters still get full pages, up to 1000 titles read per page, and a library filter reads that
  library's own index. Continue watching resolves progress rows until its 20 rows are full and
  spends at most 500 document reads (episodes and their progress rows) in all on next-episode
  lookups, reading following episodes ten at a time; a run of more than 100 watched episodes in
  a row is skipped over.
- One `jobs` table holds scan, metadata, backup, and migration jobs; `payload` carries what each
  kind needs. A claim lasts 5 seconds to 10 minutes; `renewLease` reports progress and returns
  `cancelled` when an admin cancelled the job. A cron returns expired leases to the queue every
  minute and fails a job after five attempts. A nightly cron at 03:00 UTC queues a backup job; the
  media service runs `convex export` and records the archive with `recordBackup`.

## Media playback API

- The media service's HttpApi lives in `@movies/contracts/media-api`; its routes, request and
  response schemas, and tagged errors live in `@movies/contracts/media-playback`, which uses only
  stable Effect modules. Contracts allow the unstable `effect/http-api` module for the definition
  alone. The SDK does not import the HttpApi: it posts with `fetch` and decodes the shared schemas
  (with their JSON codecs: absent optional fields arrive as `null`) and tagged errors.
- `Playback.recoveryFor` maps each failure to what a player does: `StreamGenerationGone` → load
  the current playlist (`seekStream`), `StreamNotFound` → `renegotiate`, `PlaybackTokenInvalid`
  with `expired` → `renegotiate` (renews the token first), `PlaybackSessionEnded` → start a new
  session, busy or briefly unavailable (`TranscodeCapacityReached`, `InsufficientTranscodeSpace`,
  `FileResolverUnavailable`, `SegmentNotReady`, transport) → retry later, `UnsupportedPlayback`
  → tell the viewer.
- Playback modes are one vocabulary everywhere: `direct`, `remux`, `audio-transcode`,
  `transcode-qsv`, `transcode-software`.
- A stream's ffmpeg pauses (`SIGSTOP`) once its output runs `STREAM_BUFFER_AHEAD_SECONDS` (120)
  past the furthest segment the player asked for, and continues (`SIGCONT`) when the player is
  within half of that. A remux copies at disk speed, and without the pause every play wrote most of
  its file into `TRANSCODE_DIR` within minutes. Segments behind the player stay until the stream
  closes, so a stream watched to the end still holds about the file's size.

## Artwork

- Titles, seasons, and episodes carry artwork keys: `a1.<base64url(iv ‖ ciphertext ‖ tag)>`, an
  AES-256-GCM sealing of where the image lives (an absolute path inside a library folder, or a
  TMDB image URL). The IV is an HMAC of the reference, so sealing is deterministic and rescans do
  not churn. Both keys derive from `PLAYBACK_TOKEN_SECRET` with their own labels; rotating it
  invalidates artwork keys until the next full scan.
- Clients load `${mediaBaseUrl}/artwork/${key}`, optionally `?w=` one of 185, 342, 500, 780,
  1280 (`artworkUrl` in `@movies/contracts/artwork`). No token: `<img>` cannot send one, artwork
  is low sensitivity, and a key can only name an image the service sealed itself, so the route
  cannot be pointed at other files and URLs reveal no folder names. Local images are re-checked
  against `LIBRARY_ROOTS`; remote images are fetched only from `image.tmdb.org` and cached under
  `DATA_DIR/artwork`; resized copies are JPEGs made with ffmpeg and cached by source, size, and
  modification time.

## Rich metadata

- Sources, in order: the NFO (Kodi/Jellyfin `<actor>`, `<director>`, `<credits>`/`<writer>`,
  `<studio>`, `<country>`, `<tag>`, `<ratings>`, `<uniqueid>`, `<set>`, `<trailer>`, `<status>`),
  then OMDb for IMDb, Rotten Tomatoes, and Metacritic scores (`OMDB_API_KEY`, by IMDb ID), then
  TMDB. NFO values win field by field; for cast and crew the NFO's list of a kind (actors,
  directors, writers) replaces TMDB's, and each NFO person is matched to TMDB's credit of the same
  name for a TMDB ID and photo. TMDB alone supplies creators, producers, and composers. A library
  without a TMDB key gets everything its NFO files state.
- TMDB: one details request per title with `append_to_response` (credits or `aggregate_credits`
  for shows, keywords, videos, recommendations, similar, release dates or content ratings, external
  IDs), one per season (guest stars and episode crew come with it), one per collection, and one per
  person. Requests time out after 20 seconds, share a 20 per second budget, and are cached on disk
  for a week; OMDb answers for a day, so scores refresh at most daily, and OMDb is not asked again
  for an hour after it refuses the key (wrong, or over the free tier's daily limit). Without a key
  either provider is simply absent.
- Titles keep bounded lists (20 studios, countries, and recommendations, 40 keywords) and a
  ratings object; credits live in their own table, one row per person and role, indexed by title
  and episode and by person. People are keyed `tmdb:<id>`, then `imdb:<id>`, then
  `name:<normalized name>`; a credit whose key finds nobody joins a person of the same name whose
  IDs do not contradict it, and that person gains the credit's IDs in place. Credits of a title or
  an episode are replaced as a set, skipped when the media service's digest of them is unchanged.
  `upsertScanned` returns the stored credit and collection digests, so a rescan sends only what
  changed, eight writes at a time.
- Credits travel in `mediaService.applyCredits` (per title, and per episode for guest stars and
  episode crew) and collections in `mediaService.applyCollection`, after the scan's
  `upsertScanned` batch, once per title per scan. They are extras: a failed one is logged and
  written by the next scan, without failing the scan. A scan never changes a manually matched
  title; a metadata job may, with its lease. A refresh writes credits only where none were written
  (it never replaces a scan's, often an NFO's, cast); a hand-picked match (`metadata.fixMatch`)
  replaces them. Any write keeps the provider IDs and site scores it does not carry (one a
  migration imported, a score OMDb could not give this time), and a title with IDs stays matched.
- A person's biography, dates, birthplace, and photo are fetched lazily: opening a person page
  calls `people.requestDetails` (scope `read`), which queues a `person` job at most once per person
  every six hours. A metadata refresh also fetches the ten top-billed people nobody fetched yet
  (its lease covers the people credited on its title only). A
  person the provider cannot describe (no key, or TMDB no longer has them) is recorded as fetched
  with nothing to show, so nobody asks again.
- People are visible only through titles: `people.get` lists the person's credits on titles the
  profile may see, and a person with none looks missing; `people.search` leaves them out.
- Collections: TMDB's `belongs_to_collection` (`tmdb:<id>`) or an NFO `<set>` (`tmdb:<id>` from
  Jellyfin's `tmdbcolid`, else `set:<name>`) puts a title in a collection, which is created on
  first sight or found by source key, then by name, so a TMDB collection and an imported box set
  or NFO set of the same name become one (two TMDB collections never merge by name). Such members are marked `metadata`; an import replaces only its own
  members. Members a title's metadata added sort by year.
- More like this (`titles.similar`): TMDB recommendations, then similar titles, stored as TMDB IDs
  on the title and resolved against the catalog on read (index on kind and TMDB ID), so titles
  added later appear without a refresh; topped up by shared genres (twice), keywords, and studios
  among the 300 most recently added titles of the kind. Visibility applies on read.
- `titles.list` with a genre pages through `titleGenres`, one row per title and genre carrying
  the title's kind and sort fields (Convex cannot index array members), kept in step with every
  title write and backfilled by `maintenance:backfillTitleGenres`, which `configure.ts` starts on
  each deploy. The other filters (years, studio, minimum score) apply after the page is read, like
  `libraryId`, against the year an admin may have overridden, so a filtered page may hold fewer
  items than asked for; the web grid asks for 100 at a time while filtering and keeps reading
  while its end is in view. The score is IMDb's, else TMDB's. `titles.genres` counts genres across the 1,000 most recently added titles.
- Trailers: the official YouTube trailer from TMDB videos, or a YouTube ID or URL in the NFO
  `<trailer>`. Keys are checked (`[\w-]{6,20}`) in the media service and again in Convex, and the
  web app embeds `youtube-nocookie.com` only. Local trailer files stay unstored extras.
- Migration carries the source's provider IDs: they fill IDs a matched title lacks, and an
  unmatched title that gains one is queued for a metadata refresh.

## Playback and progress

- `playback.createSession` is a mutation: it authorizes the profile and library, picks the file,
  ends the device's previous session, records the new one, and signs the token in one
  transaction. Each device has its own session; starting one on a device ends that device's
  previous session. An account plays on at most eight devices at once: starting a ninth ends the
  one that reported least recently, so one account cannot hold unbounded streams.
- A progress report from a session that started before the session owning the item's progress is
  ignored (`applied: false`), so an old tab cannot drag a newer device back. Reaching 90 percent of
  the duration, or reporting `ended`, marks the item watched; watched stays set until someone marks
  it unwatched. Sessions silent for 30 minutes end.

## Watch rooms

- A room stores `positionAtAnchorMs`, `anchorServerTime`, `status`, `playbackRate`, and
  `revision`. `rooms.create` starts it paused at revision 0; the host's device then sends
  `rooms.play`. Host commands require the host's account and device and the room's current
  revision, and bump the revision; an older revision fails with `stale_revision`.
- Heartbeats every five seconds keep members present. The host's heartbeat re-anchors the clock
  when its player is more than 250 ms off. A cron every ten seconds pauses a room whose host was
  silent for 20 seconds (`hostAway`), drops guests silent for a minute, and ends rooms abandoned
  for 30 minutes. The host leaving or ending ends the room; a guest leaving only removes them.
- Guests start their own playback session with `roomId`, which plays the room's file.
- `rooms.get` answers members while a profile they joined with may see the room's title (the host
  can switch to a title a guest's kids profile may not see). A room link (`/r/<roomId>`) reads the
  room before joining by naming the profile that would join: when it may see the title, the room
  comes back without its members. Everyone else gets `not_found`.

## Backups and restore

- The media service owns both: a nightly Convex cron queues a `backup` job, which runs
  `convex export --include-file-storage` into `BACKUP_DIR` (renamed into place only on success,
  pruned past `BACKUP_RETENTION_DAYS` only after a new backup succeeds). `POST
  /api/backups/restore` (admin) runs `convex import --replace-all`, re-registers the service key,
  then `maintenance:settleRestoredJobs` and `maintenance:endAllSessions` (a snapshot carries
  working sessions). Deployment environment variables are not part of an export. The procedure,
  including recovery without the media service, is in `docs/operations.md`; the round trip in
  `docs/spikes.md`.
- Both installs back up before deploying a new version's functions.

## Migration from Jellyfin and Plex

- Sources are in-repo migration-source plugins in `apps/media/src/migration/` (Jellyfin 10.8 or
  later, Plex Media Server 1.24 or later), behind one typed contract (`source-plugin.ts`). A
  plugin's manifest names role `migration-source` and the one host it may reach; the HTTP client
  it gets refuses other hosts, methods other than GET, and POSTs other than Jellyfin's
  `/Users/AuthenticateByName`. Plugins never read, move, copy, or link media files: import adds
  the same folders as [movies] libraries in place (`migrationService:ensureLibrary` queues their
  scans).
- Jellyfin signs in with an API key or an administrator's user name and password. Plex takes a
  local server token (`X-Plex-Token`); plex.tv is never contacted. A Plex server token reads the
  owner's positions but only the play history of other local accounts, so those import watched
  marks, play counts, and last-played dates (`history: "plays"`). Plex has no favorites.
- Flow: `migration.connect` → `migration.dryRun` → `migration.import` (media commands, scope
  `admin`) → `migration.status` (Convex query). Source failures are results, not command errors:
  `{ status: "failed", reason, message }` with `unreachable`, `auth_failed`, `not_admin`,
  `version_unsupported`, or `unexpected_response`, for the "Couldn't connect" screen. A connection
  lives in the media service's memory for an hour, private to the admin who opened it. An import
  requires a dry run of the same connection with the same user mappings, and queues exactly that
  plan.
- Access: a library the import adds is open to everyone only when every source user could see the
  source library. Otherwise it is restricted and granted to the accounts whose profiles receive an
  imported user's history, for the imported users who could see it. When the source does not say
  who sees a library (Plex: a local server token cannot read sharing, which plex.tv holds), it
  starts admins-only. The plan stores this per library (`PlannedLibrary.access`), and
  `ensureLibrary` reads it from the stored plan, never from its caller; plans stored before it
  existed also add admins-only libraries. A library the import reuses keeps its access.
  Jellyfin reports it through each user's `EnableAllFolders` and `EnabledFolders` policy. The
  Review screen says who each new library is shared with.
- Users are never created. Each source user is suggested a profile of an existing account (same
  email, then same account name, then same profile name) or `invite`; the admin may choose a
  profile or `skip` per user.
- Paths: a source path maps through the longest matching `from` prefix of the path mappings, or
  stays as is when it already lies inside `LIBRARY_ROOTS`. Without a mapping, connect infers one
  per library folder when a folder ending in the same one or two names exists under a root
  (`/data/movies` → `/mnt/nas/movies`). Paths compare after normalizing slashes, trailing slashes,
  and Unicode (NFC); Windows drive paths compare without case.
- Matching: the mapped file path first, then provider IDs (TMDB, IMDb, TVDB); episodes match
  through their show (by folder, IDs, or another episode matched by path) and season and episode
  numbers. Items in folders the import adds wait for the first scan and match by path then;
  unmatched items carry a reason (`path_unmapped`, `not_in_catalog`, `no_path`), and the dry run
  lists up to 25.
- Writes are idempotent and safe to repeat: progress is replaced only when [movies] has none or
  the source played the item more recently (otherwise [movies] keeps its own, counted as
  `keptLocal` and as a dry-run `conflict`); a watched mark is only ever added; play counts only
  grow; favorites of movies and shows go to My List; a collection is keyed by source, server ID,
  and collection ID and its members are replaced; source overrides never replace an override made
  in [movies].
- The import is a `migration` job on the media service's job worker. Its plan and checkpoint
  (phase, unit, cursor) live on the job's `migrations` row; it writes batches of at most 100 and
  checkpoints after each, so a job resumed after a crash rewrites at most one batch. Phases:
  `libraries`, `scanning` (waits up to six hours for new libraries' first scans), `watchState`,
  `collections`, `overrides`. Counts are what the job imported, counted as the dry run counts them.
  One migration per source server runs at a time. Cancelling the job stops it at the next lease
  renewal.
- Secrets: connection credentials stay in the media service's memory and are never logged; source
  requests run without HTTP client tracing because Effect does not redact `X-Plex-Token`. A job
  must survive a restart, so its stored plan carries the credentials sealed with AES-256-GCM under
  a key derived (HKDF-SHA256) from `MEDIA_SERVICE_API_KEY`, bound to the server ID and URL. Convex
  functions and their tables hold only that key's hash, so no Convex function, user, or backup can
  open them. `scripts/configure.ts` keeps the key itself in the deployment's environment variables
  so restarts reuse it; whoever holds the deployment's admin key can read it there, and already
  controls everything else.
  Rotating the key makes queued plans unreadable; their jobs fail and the admin imports again.
- Web screens (`/admin/migration`): Connect runs `migration.connect` then `migration.dryRun`, and
  shows a source failure under the field it concerns. Review maps each source user to the
  suggested account's profile, one of the admin's own profiles, or skip, and maps a source folder
  the host lacks to a local one; each change runs the dry run again (a folder mapping reconnects
  with the typed key, which stays in page memory only), so Import always matches the last dry run.
  A running import is pinned to the URL (`?job=`), so the page lands on Done. Job progress
  restarts at every phase, so the bar weighs the phases.
- The web migration suite imports from the recorded Jellyfin server by default and from a real
  Jellyfin in Docker with `MOVIES_JELLYFIN_DOCKER=1`, as CI runs it; both are served by
  `apps/media/scripts/serve-jellyfin-source.ts` over the generated fixture library.

## Web UI kit

- `@movies/ui` holds presentational components with typed props and no data access; routes wire
  them to the SDK. Link-like components take the router's link through Base UI's `render` prop.
- Components use Paper tokens only. Paper literals that are not tokens yet (such as the 11px
  keycap size, the hero title size, and the glass fill) live in a separate, labeled `@theme` block
  in `globals.css` under role names. `--color-page` is the page canvas: `bg` in light, `dark-bg`
  on dark phones, `dark-surface` on dark desktops, as Paper draws them.
- Chrome over artwork (hero, player, phone glass) uses the `on-media` utility, which remaps the
  text and state roles to their dark twins so it stays white in both themes.
- `cn` knows the Paper theme scale (`packages/ui/src/lib/utils.ts`); without it, custom sizes such
  as `text-micro` merge away next to colors such as `text-danger`.
- Desktop layout starts at `md` (48rem). Rows switch layouts with container queries, so they also
  fit narrow panels.
- Keyboard shortcuts are listed once in `apps/web/src/lib/keymap.ts` and resolved by
  `@movies/ui/lib/keymap` (`mod` is `⌘` on Apple devices and `Ctrl` elsewhere). The command menu
  draws its keycaps from that registry. Sequences such as `g h` wait one second for the next key.
- The command menu takes a typed page model (`@movies/ui/lib/command-menu`): groups scoped to
  browsing or searching, fuzzy or caller-ranked filtering, actions (sync or async) and submenus
  that replace the list in the same panel, running-job progress, and fallback commands for no
  results. Rows come from the web app's feature contributions (see Web app), which run registry
  commands through the SDK; registry entries are not mapped onto the menu one to one.
- The component gallery at `/dev/kit` is development-only; production builds replace it with an
  empty route and do not bundle it.

## Web app

- Every screen reads and writes through `@movies/sdk/react` (`useCommandQuery`, `useCommand`,
  `useAuth`); components never name Convex functions.
- Guards are components, not router `beforeLoad`, because the session lives in the SDK:
  `RequireSignedIn` sends people to `/welcome` before the owner exists and to `/sign-in?redirect=`
  after; `RequireProfile` sends them to "Who's watching?" or the profile's PIN and provides
  `useActiveProfile()` (the profile and its account's profiles). Pass `profile.id` to every
  profile-scoped command.
- The chosen profile is per browser (`localStorage` key `movies.profile`, through
  `useProfileChoice`); signing out forgets it. PIN unlocks stay per session on the server, so a
  remembered PIN profile asks for its PIN again in a new session. PINs set from the web have four
  digits, as Paper draws the boxes.
- The command menu's root list is collected from `src/commands/`: each feature exports a
  `use<Feature>Commands(context): CommandContribution` hook (groups and "No results" fallbacks),
  and `src/commands/index.ts` calls them in menu order. Groups with the same id merge, so features
  add rows to "Actions" or "Go to". `mod+shift+p` opens the menu on its "Switch profile" submenu.
- Title search lives in the menu (results while typing) and on `/search` (the full page Paper
  draws; the phone tab bar's search circle opens it). Kids filtering is server-side; the web app
  shows no notice. The menu keeps earlier results on screen only while the same query is typed
  further or shortened; a replaced query clears them, so Enter never opens a stale result.
- Artwork loads through `artworkUrl` from `@movies/contracts/artwork` against `VITE_MEDIA_BASE_URL`
  (this origin when unset), resized per use (`?w=185` thumbnails, `500` posters, `780` cards,
  stills, and logos, `1280` backdrops), as lazy images over a fixed-aspect raised placeholder; a
  missing or failing image leaves the placeholder.
  Avatars are app assets in `public/avatars/<key>.svg`; the profile stores the key.
- Play and Resume link to `/watch/$titleId?episodeId=&start=0`, which the playback milestone fills.
- Signing out navigates to sign-in itself; `RequireSignedIn` stays blank while the location is
  already `/sign-in` rather than racing that navigation with its own redirect.
- The stack E2E suite (`apps/web/e2e/stack`) runs the real media service: it generates a fixture
  library (ffmpeg clips, NFO files with certifications, artwork drawn in the browser), bundles
  `apps/media`, and starts it against the dev stack. A scan of a folder outside `LIBRARY_ROOTS`
  is the real failure path; the suite then restarts the service with that folder approved and
  retries. Fixture names are plain: Convex search matches any query term, so a shared run token in
  every name made every title match every search.

## SDK

- `@movies/sdk` runs on three Convex clients through one transport: the WebSocket `ConvexClient`
  for apps, `ConvexHttpClient` for short-lived processes (subscriptions poll), and the app's
  `ConvexReactClient` in React. Functions are called by registry path with `makeFunctionReference`.
- The SDK avoids Effect modules marked unstable, which the repo's lint rejects: media service
  requests use the platform `fetch`, and tests use plain Vitest with `TestClock`.
- Sign-in and token refresh go through a private `ConvexHttpClient`: the WebSocket client waits
  for its token before running calls, so refreshing through it would wait on itself.
- `MoviesProvider` creates and disposes its runtime in one effect, so React's development double
  mount never leaves a disposed runtime in use; children render once the runtime exists.
- The Promise facade and React commands reject with the same tagged errors the Effect API fails
  with; React queries return a `loading | success | error` state instead of throwing.
- The room engine's host publishes the difference between its player and the committed clock, not
  raw player events, so the engine's own corrections never echo back as commands. The host moves
  its player onto the committed clock only after a stale or rejected command or a reconnect; its
  own commands reach the subscription before their results do.

## Account and admin screens

- Settings, admin, and migration screens share one frame: the account's own sections, then the
  server sections its scopes open (`manage` for libraries, `admin` for users, migration, and
  backups). Routes also check scopes and show a calm state to sessions without them; the server
  still refuses every call it should, so the check only spares people broken screens.
- A new API key's secret lives only in the open "Copy your new key" dialog's state. Closing the
  dialog drops it; it is never logged, stored, or put in the URL.
- The library detail screen lists files with `libraries.files` (paged by path, or only missing
  files, or the files of unmatched titles) and counts problems with `libraries.fileSummary`, which
  reads the `by_library_missing` and `by_library_status` indexes instead of scanning the library.
- A scan that fails with the scanner's "Library root unavailable" or "Library folder unreadable"
  error shows the NAS-offline state. Other failures show as Failed on the libraries list.
- The device approval page grants `read` and `play` unless the approver changes it; it offers only
  scopes the approving session holds.
- Fix match treats a search the media service answers with `Internal` (no metadata provider, or
  one that failed) or cannot reach as search being unavailable, and keeps hand edits working.
  `RateLimited` asks to try again; other failures show their message. Only unmatched files carry a
  Fix match button; a matched file's title opens the same screen.
- Dialogs the command menu opens live in the URL: `/settings/api-keys?dialog=create` and
  `/admin/libraries?dialog=add`. Menu entries follow the session's scopes, like the settings list.
  A query shaped like a device code (`HD5R-5GTL`) offers to approve it.
- The admin browser suites (`apps/web/e2e/admin`) run as a Playwright project that depends on the
  stack project and sign in as the owner it creates, so both share one fresh stack without racing
  for the first owner. Library scans run on the real media service with generated clips, and the
  backups suite runs a real backup job in its own project last, since each suite that runs a
  media service owns the stack's port while it runs: the service exports the stack into its backup
  folder.
