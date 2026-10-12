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
  profile for five minutes. Changing or deleting a PIN profile requires it to be unlocked.
- Sessions created by an API key or device sign-in carry a grant with explicit scopes, stored on
  the `authSessions` row itself. Effective scopes are the grant's scopes that the role still
  allows, so demoting an admin strips `manage` and `admin` from their keys and devices at once.
  Password sessions have no grant and hold every scope their role allows.
- Scopes: `read` (browse, search, history, room state, PIN unlock), `play` (playback sessions,
  progress, my list, watched marks, rooms), `account` (the account's own profiles, PINs, API keys,
  device approvals, and sessions), `manage` (libraries, scans, jobs, metadata fixes; admin role
  required), `admin` (users, invites, other people's keys, backups, restore, migration; admin role
  required), and `media-service`. `account` was added so a key or device can never mint
  credentials unless explicitly granted it; API keys can never hold it.
- API keys hold a non-empty subset of `read`, `play`, `manage`, `admin`, never more than the
  creating session holds. Device approvals grant a subset of the approving session's scopes and
  may include `account`. `media-service` is never grantable.
- The media service signs in with `MEDIA_SERVICE_API_KEY` through the `apikey` provider. The key
  belongs to the `service` account, is created by `packages/backend/scripts/configure.ts`, and its
  grant carries only `media-service`, which allows the media functions and nothing else.
- Every public Convex function checks the viewer's scopes server-side, and checks the session row
  on every call: signing out, revoking a key, revoking a session, or disabling the account ends
  its tokens immediately and ends the playback sessions it started.

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

## Playback and progress

- `playback.createSession` is a mutation: it authorizes the profile and library, picks the file,
  ends the device's previous session, records the new one, and signs the token in one
  transaction. Each device has its own session; starting one on a device ends that device's
  previous session.
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

## Backups and restore

- Restore: stop writes, `convex import --replace-all --yes <zip>`, then
  `convex run maintenance:endAllSessions` (a snapshot carries working sessions), then run
  `scripts/configure.ts` again. Deployment environment variables are not part of an export. See
  `docs/spikes.md`.

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
  results. Once the command registry in `@movies/contracts` exists, its entries map onto this model.
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
