# Spikes

Results of the first-week checks the architecture asked for. Each section records what was run,
against which versions, and what it showed. Add a section per spike; keep the headings stable.

## Convex runtime, auth, export/restore

Run 2026-10-12 against the self-hosted backend started by `scripts/dev-stack.sh`
(`ghcr.io/get-convex/convex-backend:latest`), `convex` 1.46.0, `@convex-dev/auth` 0.0.96,
`@auth/core` 0.41.3, Node 24.20.

### HMAC playback tokens in the Convex runtime

- **Result: works in every function type.** A throwaway module ran `crypto.subtle.importKey`
  (raw, HMAC SHA-256), `sign`, `verify`, and `digest("SHA-256")` in a query, a mutation, and an
  action; each produced the same signature as Node's `createHmac` for the same key and message.
  `btoa`/`atob` and `crypto.getRandomValues` are present too. `Buffer` is not.
- **Choice:** `playback.createSession` is a single **mutation**: it authorizes, writes the
  session, and signs the token in one transaction. No action wrapper is needed.
- **Proof kept in the repo:** `packages/backend/test/registry.test.ts` checks that the Convex
  signer (`convex/lib/playbackToken.ts`) reproduces `PLAYBACK_TOKEN_TEST_VECTORS` byte for byte,
  and `packages/backend/test/stack.test.ts` verifies a token minted by the live backend with the
  contracts verifier (`verifyPlaybackToken`) and the stack's `PLAYBACK_TOKEN_SECRET`.
- **Randomness:** `getRandomValues` in mutations returned different values per call, but Convex
  documents query and mutation randomness as seeded for determinism. Secrets (API keys, invite
  codes, device codes) are therefore minted in **actions** that call an internal mutation; only
  PIN salts come from mutation randomness.

### Convex Auth: password, API key, and device flows with scoped revocation

- **Result: works.** Verified by `pnpm --filter @movies/backend test:stack` (22 tests).
- `ConvexCredentials.authorize` may return an existing `sessionId`, and Convex Auth then issues
  tokens for that session instead of creating one. The `apikey` and `device` providers create (or
  reuse) the session themselves in an internal mutation and store the **grant on the
  `authSessions` row** (the table is redefined with an optional `grant` field). A restricted
  session therefore cannot outlive its grant as an unrestricted one; password sessions have no
  grant and hold their role's scopes.
- Convex Auth JWTs last an hour, so every public function loads the session row: deleting it
  (sign-out, key revocation, `sessions.revoke`, disabling the account) cuts off its tokens at once.
  The stack tests confirm a revoked key's token fails with `unauthenticated` on the next call and
  the key no longer signs in, and a revoked device session fails the same way.
- A deliberate regression (ignoring grants in `sessionScopes`) fails the API key and device tests,
  so the suite guards this seam.
- Device codes are consumed in the same transaction that creates the session; the second sign-in
  with a code returns no session. Expiry was checked by importing an approved code whose
  `expiresAt` had passed (the suite uses `convex import --append`): `deviceAuth.status` reports
  `expired` and sign-in is refused.
- The built-in `Password` provider's `profile` callback receives untyped params and must return
  typed fields synchronously, which would need a `typeof` or a cast. The `password` provider here
  is a small `ConvexCredentials` that parses params through an internal query's `v` validator and
  calls Convex Auth's `createAccount`/`retrieveAccount` with lucia's Scrypt, the same hashing the
  built-in provider uses. Convex Auth's failed-sign-in rate limit still applies.
- The generated `DataModel` does not satisfy `GenericDataModel` under
  `exactOptionalPropertyTypes` (TS2344), so the providers use `ConvexCredentials` without the
  `DataModel` type argument; all other Convex code compiles with the strict flag.

### `convex export` / `convex import` round trip

Ran `convex export --include-file-storage` against the test stack after the suite had run, then
`MOVIES_STACK=restore-spike scripts/dev-stack.sh up` and `convex import --replace-all --yes` of
the ZIP into the fresh stack.

- **Export:** 40 KB ZIP in under a second, one folder per table: every application table and
  every Convex Auth table (`authAccounts`, `authSessions`, `authRefreshTokens`, `authRateLimits`,
  `authVerifiers`, `authVerificationCodes`), plus an empty `_storage`. Deployment environment
  variables (JWT keys, `PLAYBACK_TOKEN_SECRET`, `MEDIA_SERVICE_API_KEY`, `SITE_URL`,
  `MEDIA_BASE_URL`) are **not** in the export; scheduled functions are not either (crons come
  back from code).
- **Import:** 340 documents in about two seconds. Users, libraries, titles, files, and history
  were present; `setup.status` reported an owner; the owner signed in with their password (the
  password hashes travel in `authAccounts`; the new deployment's JWT keys sign the new tokens).
- **Sessions survive a restore.** A refresh token taken from the snapshot was accepted by the
  restored deployment even though its JWT keys differ. The restore procedure must end them:
  `convex run maintenance:endAllSessions` (added for this) signed out 35 sessions, after which the
  old refresh token was rejected and password sign-in still worked.
- **Media service key after restore:** the snapshot's `apiKeys` table replaced the one holding
  the restored deployment's own service key hash, so the service could not sign in until
  `scripts/configure.ts` ran again (it re-registers the key from `MEDIA_SERVICE_API_KEY`).
  Restoring into the same deployment, whose environment still holds the matching key, does not
  need this, but running `configure.ts` after every restore is harmless and covers both cases.
- **Restore procedure** (for the media service's `backups.restore`): stop writes, `convex import
  --replace-all --yes <zip>`, `convex run maintenance:endAllSessions`, run `scripts/configure.ts`,
  then verify sign-in, library access, playback, and history. Keep the deployment environment in
  the separately protected recovery store; the export does not replace it.
- The spike stack was destroyed afterwards (`MOVIES_STACK=restore-spike scripts/dev-stack.sh
  destroy`).
