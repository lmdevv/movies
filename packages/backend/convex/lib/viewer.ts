/**
 * Who is calling and what their session may do. Every public function starts with `authorize`,
 * except the few anonymous ones (setup status, invite lookup, device sign-in requests).
 */
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { endPlaybackSession } from "./endings";
import { fail } from "./errors";
import { sessionScopes } from "./scopes";
import type { Scope } from "./scopes";

/** The context a read needs: queries, mutations, and the auth identity. */
export type ReadCtx = Pick<QueryCtx, "db" | "auth">;

/** The signed-in account, its session, and the scopes that session holds now. */
export interface Viewer {
  readonly userId: Id<"users">;
  readonly user: Doc<"users">;
  readonly session: Doc<"authSessions">;
  readonly scopes: ReadonlySet<Scope>;
  /** Whether `GUARDED_SCOPES` were withheld until a PIN profile is unlocked (`guardianLocked`). */
  readonly guardianLocked: boolean;
}

/** Scopes a shared browser keeps only while an adult's PIN profile is unlocked on it. */
const GUARDED_SCOPES: ReadonlySet<Scope> = new Set(["account", "manage", "admin"]);

const isRestricted = (profile: Doc<"profiles">): boolean =>
  profile.kids || profile.maxAgeRating !== null;

/**
 * Whether a password session must unlock an adult's PIN profile before it may change the account
 * or the server. That holds when the account has a kids or rated profile and every unrestricted
 * profile has a PIN: only then do PINs keep someone in the limited profile, and only then could
 * that profile otherwise lift its own limits, create an open profile, or re-rate titles. API key
 * and device sessions are exempt: whoever minted them already held these scopes.
 */
const guardianLocked = async (
  ctx: ReadCtx,
  userId: Id<"users">,
  session: Doc<"authSessions">,
): Promise<boolean> => {
  if (session.grant !== undefined) return false;

  const profiles = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  const adults = profiles.filter((profile) => !isRestricted(profile));

  if (adults.length === profiles.length || adults.some((adult) => adult.pinHash === undefined)) {
    return false;
  }

  const unlocked = new Set(session.unlockedProfiles ?? []);

  return !adults.some((adult) => unlocked.has(adult._id));
};

/**
 * Whether an API key session's key still allows it. Revoking a key also deletes its session, but
 * checking the key here keeps a session from outliving its key however it ended: revoked, deleted,
 * or past its expiry while a token issued before then is still valid.
 */
const keyAllows = async (
  ctx: ReadCtx,
  session: Doc<"authSessions">,
  now: number,
): Promise<boolean> => {
  if (session.grant?.kind !== "apikey") return true;

  const key =
    session.grant.apiKeyId === undefined ? null : await ctx.db.get(session.grant.apiKeyId);

  return (
    key !== null &&
    key.revokedAt === undefined &&
    (key.expiresAt === undefined || key.expiresAt > now)
  );
};

/**
 * Loads the viewer or fails with `unauthenticated`. Convex Auth's JWTs live an hour, so the session
 * row is checked on every call: deleting a session (sign-out, key revocation, disabling the account)
 * cuts off every token issued for it at once, and so does the session reaching its expiration
 * time or, for an API key session, its key being revoked, deleted, or expired.
 */
export const loadViewer = async (ctx: ReadCtx): Promise<Viewer> => {
  const userId = await getAuthUserId(ctx);

  if (userId === null) return fail("unauthenticated", "Sign in first");
  const sessionId = ctx.db.normalizeId("authSessions", (await getAuthSessionId(ctx)) ?? "");
  const session = sessionId === null ? null : await ctx.db.get(sessionId);

  const now = Date.now();

  if (
    session?.userId !== userId ||
    session.expirationTime <= now ||
    !(await keyAllows(ctx, session, now))
  ) {
    return fail("unauthenticated", "This session has ended; sign in again");
  }

  const user = await ctx.db.get(userId);

  if (user === null) return fail("unauthenticated", "This account no longer exists");

  if (user.disabledAt !== undefined) return fail("unauthenticated", "This account is disabled");

  const locked = await guardianLocked(ctx, userId, session);
  const held = sessionScopes(session, user.role);

  return {
    userId,
    user,
    session,
    scopes: new Set(locked ? held.filter((granted) => !GUARDED_SCOPES.has(granted)) : held),
    guardianLocked: locked && held.some((granted) => GUARDED_SCOPES.has(granted)),
  };
};

/** Loads the viewer and requires a scope, or just a session for `authenticated`. */
export const authorize = async (ctx: ReadCtx, access: Scope | "authenticated"): Promise<Viewer> => {
  const viewer = await loadViewer(ctx);

  if (access !== "authenticated" && !viewer.scopes.has(access)) {
    return viewer.guardianLocked && GUARDED_SCOPES.has(access)
      ? fail(
          "forbidden",
          "Choose an adult profile and enter its PIN to change the account or the server",
        )
      : fail("forbidden", `This session lacks the ${access} scope`);
  }

  return viewer;
};

/**
 * Ends a sign-in session as Convex Auth's sign-out does, and also ends the playback sessions it
 * started so the media service stops their streams.
 */
export const endAuthSession = async (
  ctx: MutationCtx,
  sessionId: Id<"authSessions">,
): Promise<void> => {
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();

  await Promise.all(refreshTokens.map((token) => ctx.db.delete(token._id)));

  const playback = await ctx.db
    .query("playbackSessions")
    .withIndex("by_auth_session", (q) => q.eq("authSessionId", sessionId))
    .collect();

  const now = Date.now();

  await Promise.all(
    playback.flatMap((session) =>
      session.status === "active" ? [endPlaybackSession(ctx, session, now)] : [],
    ),
  );

  if ((await ctx.db.get(sessionId)) !== null) await ctx.db.delete(sessionId);
};
