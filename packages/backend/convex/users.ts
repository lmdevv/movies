import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { sha256Hex } from "./lib/crypto";
import { fail } from "./lib/errors";
import { presentUser } from "./lib/present";
import { authorize, endAuthSession } from "./lib/viewer";
import { assignableRole, ok, user } from "./lib/validators";

const DEFAULT_AVATAR = "red";

const insertDefaultProfile = async (
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
): Promise<void> => {
  await ctx.db.insert("profiles", {
    userId,
    name,
    avatar: DEFAULT_AVATAR,
    kids: false,
    maxAgeRating: null,
    pinFailures: 0,
  });
};

/**
 * Creates the account for a password sign-up, with a first profile. The first account becomes the
 * owner; every later one needs an open invite, whose role it receives. Concurrent first sign-ups
 * conflict on the owner lookup, so exactly one becomes the owner.
 */
export const createFromSignUp = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    inviteCode: v.optional(v.string()),
    role: v.literal("member"),
  },
  returns: v.id("users"),
  handler: async (ctx, { email, name, inviteCode }) => {
    const typedName = name?.trim() ?? "";
    const displayName = typedName.length > 0 ? typedName : (email.split("@")[0] ?? email);

    const owner = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .first();

    if (owner === null) {
      const userId = await ctx.db.insert("users", { email, name: displayName, role: "owner" });
      await insertDefaultProfile(ctx, userId, displayName);

      return userId;
    }

    if (inviteCode === undefined || inviteCode.trim().length === 0) {
      return fail("forbidden", "Sign-up needs an invite from an admin");
    }

    const codeHash = await sha256Hex(inviteCode.trim());

    const invite = await ctx.db
      .query("invites")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
      .unique();

    const now = Date.now();

    if (invite === null || invite.revokedAt !== undefined) {
      return fail("forbidden", "This invite is not valid");
    }

    if (invite.acceptedBy !== undefined) return fail("conflict", "This invite was already used");

    if (invite.expiresAt <= now) return fail("expired", "This invite has expired");

    if (invite.email !== null && invite.email !== email) {
      return fail("forbidden", "This invite is for another email address");
    }

    const userId = await ctx.db.insert("users", { email, name: displayName, role: invite.role });
    await ctx.db.patch(invite._id, { acceptedBy: userId, acceptedAt: now });
    await insertDefaultProfile(ctx, userId, displayName);

    return userId;
  },
});

/** Rejects sign-ins for disabled accounts and the media service's system account. */
export const assertCanSignIn = internalQuery({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const account = await ctx.db.get(userId);

    if (account === null || account.disabledAt !== undefined) {
      return fail("unauthenticated", "This account is disabled");
    }

    if (account.role === "service") {
      return fail("forbidden", "The media service account cannot sign in with a password");
    }

    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(user),
  handler: async (ctx) => {
    await authorize(ctx, "admin");
    const users = await ctx.db.query("users").collect();

    return users.flatMap((doc) => (doc.role === "service" ? [] : [presentUser(doc)]));
  },
});

const loadManagedUser = async (ctx: MutationCtx, userId: Id<"users">, self: Id<"users">) => {
  const target = await ctx.db.get(userId);

  if (target === null || target.role === "service") return fail("not_found", "No such account");

  if (target.role === "owner") return fail("forbidden", "The owner's account cannot be changed");

  if (target._id === self) return fail("forbidden", "Ask another admin to change your own account");

  return target;
};

export const setRole = mutation({
  args: { userId: v.id("users"), role: assignableRole },
  returns: ok,
  handler: async (ctx, { userId, role }) => {
    const viewer = await authorize(ctx, "admin");
    await loadManagedUser(ctx, userId, viewer.userId);
    await ctx.db.patch(userId, { role });

    return { ok: true as const };
  },
});

export const disable = mutation({
  args: { userId: v.id("users") },
  returns: ok,
  handler: async (ctx, { userId }) => {
    const viewer = await authorize(ctx, "admin");
    await loadManagedUser(ctx, userId, viewer.userId);
    await ctx.db.patch(userId, { disabledAt: Date.now() });

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();

    await Promise.all(sessions.map((session) => endAuthSession(ctx, session._id)));

    return { ok: true as const };
  },
});

export const enable = mutation({
  args: { userId: v.id("users") },
  returns: ok,
  handler: async (ctx, { userId }) => {
    const viewer = await authorize(ctx, "admin");
    await loadManagedUser(ctx, userId, viewer.userId);
    await ctx.db.patch(userId, { disabledAt: undefined });

    return { ok: true as const };
  },
});

export const setLibraryAccess = mutation({
  args: { userId: v.id("users"), libraryIds: v.array(v.id("libraries")) },
  returns: ok,
  handler: async (ctx, { userId, libraryIds }) => {
    await authorize(ctx, "admin");
    const target = await ctx.db.get(userId);

    if (target === null || target.role === "service") return fail("not_found", "No such account");

    const libraries = await Promise.all(libraryIds.map((libraryId) => ctx.db.get(libraryId)));

    if (libraries.includes(null)) return fail("not_found", "No such library");

    const existing = await ctx.db
      .query("libraryGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const wanted = new Set(libraryIds);
    const kept = new Set(existing.map((grant) => grant.libraryId));

    await Promise.all([
      ...existing.flatMap((grant) =>
        wanted.has(grant.libraryId) ? [] : [ctx.db.delete(grant._id)],
      ),
      ...[...wanted].flatMap((libraryId) =>
        kept.has(libraryId) ? [] : [ctx.db.insert("libraryGrants", { userId, libraryId })],
      ),
    ]);

    return { ok: true as const };
  },
});
