import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { endAuthSession } from "./lib/viewer";
import { setupStatus } from "./lib/validators";

/** First-run state for the welcome screen. Public: it reveals only whether setup has happened. */
export const status = query({
  args: {},
  returns: setupStatus,
  handler: async (ctx) => {
    const owner = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .first();

    const library = await ctx.db.query("libraries").first();

    return { hasOwner: owner !== null, hasLibraries: library !== null };
  },
});

/**
 * Ensures the media service's system account and its API key exist, for `scripts/configure.ts`
 * (`convex run setup:ensureServiceKey`). Only the key's hash arrives here. A different hash rotates
 * the key: older service keys are revoked and their sessions end.
 */
export const ensureServiceKey = internalMutation({
  args: { hash: v.string(), prefix: v.string() },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, { hash, prefix }) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "service"))
      .first();

    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", { name: "Media service", role: "service" }));

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const now = Date.now();
    const current = keys.find((key) => key.hash === hash && key.revokedAt === undefined);

    await Promise.all(
      keys
        .filter((key) => key !== current && key.revokedAt === undefined)
        .map(async (key) => {
          await ctx.db.patch(key._id, { revokedAt: now });

          if (key.sessionId !== undefined) await endAuthSession(ctx, key.sessionId);
        }),
    );

    if (current !== undefined) return { created: false };

    await ctx.db.insert("apiKeys", {
      userId,
      name: "Media service",
      prefix,
      hash,
      scopes: [],
      service: true,
    });

    return { created: true };
  },
});
