/**
 * Who is calling and what their session may do. Every public function starts with `authorize`,
 * except the few anonymous ones (setup status, invite lookup, device sign-in requests).
 */
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
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
}

/**
 * Loads the viewer or fails with `unauthenticated`. Convex Auth's JWTs live an hour, so the session
 * row is checked on every call: deleting a session (sign-out, key revocation, disabling the account)
 * cuts off every token issued for it at once.
 */
export const loadViewer = async (ctx: ReadCtx): Promise<Viewer> => {
  const userId = await getAuthUserId(ctx);

  if (userId === null) return fail("unauthenticated", "Sign in first");
  const sessionId = ctx.db.normalizeId("authSessions", (await getAuthSessionId(ctx)) ?? "");
  const session = sessionId === null ? null : await ctx.db.get(sessionId);

  if (session?.userId !== userId) {
    return fail("unauthenticated", "This session has ended; sign in again");
  }

  const user = await ctx.db.get(userId);

  if (user === null) return fail("unauthenticated", "This account no longer exists");

  if (user.disabledAt !== undefined) return fail("unauthenticated", "This account is disabled");

  return { userId, user, session, scopes: new Set(sessionScopes(session, user.role)) };
};

/** Loads the viewer and requires a scope, or just a session for `authenticated`. */
export const authorize = async (ctx: ReadCtx, access: Scope | "authenticated"): Promise<Viewer> => {
  const viewer = await loadViewer(ctx);

  if (access !== "authenticated" && !viewer.scopes.has(access)) {
    return fail("forbidden", `This session lacks the ${access} scope`);
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
      session.status === "active"
        ? [ctx.db.patch(session._id, { status: "ended", endedAt: now })]
        : [],
    ),
  );

  if ((await ctx.db.get(sessionId)) !== null) await ctx.db.delete(sessionId);
};
