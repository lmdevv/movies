import { v } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { PASSWORD_MIN } from "./lib/bounds";
import { fail } from "./lib/errors";
import { presentUser } from "./lib/present";
import { ok, viewer as viewerResult } from "./lib/validators";
import { authorize, endAuthSession } from "./lib/viewer";

/**
 * The signed-in account and its session's scopes. The media service calls this with a user's
 * token to authorize `media` commands.
 */
export const viewer = query({
  args: {},
  returns: viewerResult,
  handler: async (ctx) => {
    const current = await authorize(ctx, "authenticated");

    return {
      user: presentUser(current.user),
      sessionId: current.session._id,
      sessionKind: current.session.grant?.kind ?? ("password" as const),
      scopes: [...current.scopes],
    };
  },
});

/**
 * The email the calling account signs in with and the session calling, for `changePassword`.
 * Requires `account` scope; fails with `not_found` for an account without a password, such as the
 * media service's.
 */
export const passwordSignIn = internalQuery({
  args: {},
  returns: v.object({
    email: v.string(),
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
  }),
  handler: async (ctx) => {
    const current = await authorize(ctx, "account");

    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", current.userId).eq("provider", "password"),
      )
      .unique();

    if (account === null) return fail("not_found", "This account has no password to change");

    return {
      email: account.providerAccountId,
      userId: current.userId,
      sessionId: current.session._id,
    };
  },
});

/**
 * Ends the account's other password and device sessions after a password change, keeping `keep`.
 * API key sessions stay: a key signs in again on its next use whatever the password, so revoking
 * the key is what stops it.
 */
export const endOtherSessions = internalMutation({
  args: { userId: v.id("users"), keep: v.id("authSessions") },
  returns: v.null(),
  handler: async (ctx, { userId, keep }) => {
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();

    await Promise.all(
      sessions.flatMap((session) =>
        session._id === keep || session.grant?.kind === "apikey"
          ? []
          : [endAuthSession(ctx, session._id)],
      ),
    );

    return null;
  },
});

/**
 * Changes the calling account's password after checking the current one, then signs out the
 * account's other password and device sessions. Wrong guesses count toward the same lockout as
 * sign-in. Requires `account` scope.
 *
 * Both steps go through Convex Auth's own `store`, as its `retrieveAccount` and
 * `modifyAccountCredentials` helpers do (their context type does not accept this data model), so
 * the password provider checks and hashes the secrets.
 */
export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  returns: ok,
  handler: async (ctx, { currentPassword, newPassword }) => {
    const { email, userId, sessionId } = await ctx.runQuery(internal.account.passwordSignIn, {});

    if (newPassword.length < PASSWORD_MIN) {
      return fail("invalid_args", `Use at least ${PASSWORD_MIN} characters for the password`);
    }

    // Convex Auth answers with the account, or a reason it refused the secret.
    const checked: unknown = await ctx.runMutation(internal.auth.store, {
      args: {
        type: "retrieveAccountWithCredentials",
        provider: "password",
        account: { id: email, secret: currentPassword },
      },
    });

    if (checked === "TooManyFailedAttempts") {
      return fail("rate_limited", "Too many wrong passwords; wait a few minutes and try again");
    }

    // Only an answer carrying the account accepts the password; every other answer refuses it.
    if (!(checked instanceof Object && Object.hasOwn(checked, "account"))) {
      return fail("forbidden", "The current password is wrong");
    }

    await ctx.runMutation(internal.auth.store, {
      args: {
        type: "modifyAccount",
        provider: "password",
        account: { id: email, secret: newPassword },
      },
    });

    await ctx.runMutation(internal.account.endOtherSessions, { userId, keep: sessionId });

    return { ok: true as const };
  },
});
