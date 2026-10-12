import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { fail } from "./lib/errors";
import { createdAt } from "./lib/present";
import { sessionScopes } from "./lib/scopes";
import { ok, sessionInfo } from "./lib/validators";
import { authorize, endAuthSession } from "./lib/viewer";

/** Signed-in browsers, devices, and API keys of the account, newest first. */
export const list = query({
  args: {},
  returns: v.array(sessionInfo),
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "account");

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", viewer.userId))
      .order("desc")
      .collect();

    return sessions.map((session) => ({
      id: session._id,
      kind: session.grant?.kind ?? ("password" as const),
      label: session.grant?.label ?? null,
      scopes: [...sessionScopes(session, viewer.user.role)],
      createdAt: createdAt(session),
      expiresAt: session.expirationTime,
      current: session._id === viewer.session._id,
    }));
  },
});

/** Signs out one of the account's sessions; API key sessions reopen on the key's next sign-in. */
export const revoke = mutation({
  args: { sessionId: v.id("authSessions") },
  returns: ok,
  handler: async (ctx, { sessionId }) => {
    const viewer = await authorize(ctx, "account");
    const session = await ctx.db.get(sessionId);

    if (session?.userId !== viewer.userId) return fail("not_found", "No such session");

    await endAuthSession(ctx, sessionId);

    return { ok: true as const };
  },
});
