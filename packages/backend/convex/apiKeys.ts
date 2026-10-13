import { v } from "convex/values";
import type { Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { checkDisplayName } from "./lib/bounds";
import { randomSecret, sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { presentApiKey } from "./lib/present";
import { apiKey, apiKeyScope, createdApiKey, ok } from "./lib/validators";
import { authorize, endAuthSession } from "./lib/viewer";
import type { ReadCtx, Viewer } from "./lib/viewer";

/** How long one sign-in session of a key lasts; the next sign-in after it opens a new one. */
const KEY_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stores a new key for the signed-in account; `create` minted the secret with real randomness. */
export const insert = internalMutation({
  args: {
    name: v.string(),
    prefix: v.string(),
    hash: v.string(),
    scopes: v.array(apiKeyScope),
    expiresInDays: v.optional(v.number()),
  },
  returns: apiKey,
  handler: async (ctx, { name, prefix, hash, scopes, expiresInDays }) => {
    const viewer = await authorize(ctx, "account");
    const requested = [...new Set(scopes)];

    if (requested.length === 0) return fail("invalid_args", "Choose at least one scope");

    const missing = requested.filter((wanted) => !viewer.scopes.has(wanted));

    if (missing.length > 0) {
      return fail("forbidden", `This session cannot grant ${missing.join(", ")}`);
    }

    if (
      expiresInDays !== undefined &&
      (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)
    ) {
      return fail("invalid_args", "Keys expire after 1 to 365 days");
    }

    const key = {
      userId: viewer.userId,
      name: checkDisplayName(name, "Key names"),
      prefix,
      hash,
      scopes: requested,
    };

    const keyId = await ctx.db.insert(
      "apiKeys",
      expiresInDays === undefined
        ? key
        : { ...key, expiresAt: Date.now() + expiresInDays * DAY_MS },
    );

    const created = await ctx.db.get(keyId);

    if (created === null) return fail("internal", "The key vanished right after it was created");

    return presentApiKey(created);
  },
});

export const create = action({
  args: {
    name: v.string(),
    scopes: v.array(apiKeyScope),
    expiresInDays: v.optional(v.number()),
  },
  returns: createdApiKey,
  handler: async (ctx, { name, scopes, expiresInDays }): Promise<Infer<typeof createdApiKey>> => {
    const prefix = `mk_${randomSecret(6)}`;
    const secret = `${prefix}_${randomSecret(24)}`;

    const key = { name, prefix, hash: await sha256Hex(secret), scopes };

    const created = await ctx.runMutation(
      internal.apiKeys.insert,
      expiresInDays === undefined ? key : { ...key, expiresInDays },
    );

    return { apiKey: created, secret };
  },
});

/**
 * Whether the viewer may see and revoke `owner`'s keys: their own, or as an admin another account's
 * except the owner's, which `users.ts` protects from other admins the same way.
 */
const managesKeysOf = async (
  ctx: ReadCtx,
  viewer: Viewer,
  owner: Id<"users">,
): Promise<boolean> => {
  if (owner === viewer.userId) return true;

  if (!viewer.scopes.has("admin")) return false;

  return (await ctx.db.get(owner))?.role !== "owner";
};

export const list = query({
  args: { userId: v.optional(v.id("users")) },
  returns: v.array(apiKey),
  handler: async (ctx, { userId }) => {
    const viewer = await authorize(ctx, "account");
    const owner = userId ?? viewer.userId;

    if (!(await managesKeysOf(ctx, viewer, owner))) {
      return fail("forbidden", "Only admins can list another account's keys, and not the owner's");
    }

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", owner))
      .collect();

    return keys.flatMap((key) => (key.service === true ? [] : [presentApiKey(key)]));
  },
});

export const revoke = mutation({
  args: { apiKeyId: v.id("apiKeys") },
  returns: ok,
  handler: async (ctx, { apiKeyId }) => {
    const viewer = await authorize(ctx, "account");
    const key = await ctx.db.get(apiKeyId);

    if (key === null || key.service === true || !(await managesKeysOf(ctx, viewer, key.userId))) {
      return fail("not_found", "No such API key");
    }

    if (key.revokedAt === undefined) await ctx.db.patch(apiKeyId, { revokedAt: Date.now() });

    if (key.sessionId !== undefined) await endAuthSession(ctx, key.sessionId);

    return { ok: true as const };
  },
});

/**
 * Signs in with an API key for the `apikey` provider. Every sign-in with one key shares one
 * session whose grant carries the key's scopes, so revoking the key ends every token it issued.
 * The media service's key grants `media-service` and nothing else. Returns null to refuse.
 */
export const redeem = internalMutation({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { key }) => {
    const hash = await sha256Hex(key);

    const found = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();

    const now = Date.now();

    if (
      found === null ||
      found.revokedAt !== undefined ||
      (found.expiresAt !== undefined && found.expiresAt <= now)
    ) {
      return null;
    }

    const owner = await ctx.db.get(found.userId);

    if (owner === null || owner.disabledAt !== undefined) return null;

    const isServiceKey = found.service === true && owner.role === "service";

    if (found.service === true && !isServiceKey) return null;

    const current = found.sessionId === undefined ? null : await ctx.db.get(found.sessionId);

    if (current !== null && current.expirationTime > now) {
      await ctx.db.patch(found._id, { lastUsedAt: now });

      return { userId: found.userId, sessionId: current._id };
    }

    if (current !== null) await endAuthSession(ctx, current._id);

    const sessionId = await ctx.db.insert("authSessions", {
      userId: found.userId,
      // A key's session ends with the key, so a refresh token cannot carry it past its expiry.
      expirationTime: Math.min(now + KEY_SESSION_MS, found.expiresAt ?? Number.POSITIVE_INFINITY),
      grant: {
        kind: "apikey",
        scopes: isServiceKey ? ["media-service"] : found.scopes,
        label: found.name,
        apiKeyId: found._id,
      },
    });

    await ctx.db.patch(found._id, { lastUsedAt: now, sessionId });

    return { userId: found.userId, sessionId };
  },
});
