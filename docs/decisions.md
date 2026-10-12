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
- Convex signs with WebCrypto in plain TypeScript. The media service verifies with Effect in
  constant time and rejects a wrong audience, a bad signature, or `exp <= now`. Shared test vectors
  in `packages/contracts` keep both sides honest.
- Tokens never appear in logs. Media URLs carry the token in the `token` query parameter because
  `<video>` and HLS segment fetches cannot set headers.

## Identities, roles, and scopes

- A Convex Auth user is an account. Roles: `owner` (first account), `admin`, `member`.
- Profiles belong to an account. A kids profile has a maximum rating; any profile may have a PIN.
- Sessions created by an API key or device sign-in are bound to a grant with explicit scopes.
  Password sessions carry every scope the account's role allows.
- Scopes: `read` (browse, search, history), `play` (playback sessions, progress, rooms),
  `manage` (libraries, scans, metadata fixes; admin role required), `admin` (users, invites,
  keys of others, backups, restore, migration; admin role required), and `media-service`.
- The media service signs in with `MEDIA_SERVICE_API_KEY` through the `apikey` provider. Its grant
  carries only `media-service`, which allows the media functions and nothing else.
- Every public Convex function checks the viewer's scopes server-side.

## Command registry

- `@movies/contracts` lists every user action once: name (dotted, such as `titles.list`), summary,
  group, kind (`query`, `mutation`, `action`, or `media` for media-service HTTP calls), required
  scope, Effect Schema args and result, and the Convex function path it calls.
- Convex functions stay plain TypeScript with `v` validators. A backend test checks that each
  registry entry points at an existing function and that its validators match the schemas.
- The SDK, CLI, and command menu are generated from the registry.

## Media service and Convex

- Convex never calls the media service. The media service subscribes to its job and ended-session
  queries and calls `media-service` scoped mutations.
- Scan jobs use leases: a claim writes `leaseOwner` and `leaseExpiresAt`; the worker renews it, and
  an expired lease can be reclaimed after a restart.
