import { v } from "convex/values";
import type { Infer } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { randomSecret, sha256Hex } from "./lib/crypto";
import { siteUrl } from "./lib/env";
import { fail } from "./lib/errors";
import { presentInvite } from "./lib/present";
import {
  assignableRole,
  createdInvite,
  invite,
  inviteLookup,
  nullable,
  ok,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_INVITE_DAYS = 7;

/** What the accept-invite screen shows. Public: it reveals details only to holders of the code. */
export const lookup = query({
  args: { code: v.string() },
  returns: inviteLookup,
  handler: async (ctx, { code }) => {
    const codeHash = await sha256Hex(code.trim());

    const found = await ctx.db
      .query("invites")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash))
      .unique();

    if (found === null || found.revokedAt !== undefined) return { state: "invalid" as const };
    const inviter = await ctx.db.get(found.createdBy);

    const details = {
      email: found.email,
      inviterName: inviter?.name ?? "An admin",
      expiresAt: found.expiresAt,
    };

    if (found.acceptedBy !== undefined) return { state: "used" as const, ...details };

    if (found.expiresAt <= Date.now()) return { state: "expired" as const, ...details };

    return { state: "open" as const, ...details };
  },
});

/** Stores a new invite for an admin; `create` minted the code with real randomness. */
export const insert = internalMutation({
  args: {
    codeHash: v.string(),
    email: nullable(v.string()),
    role: assignableRole,
    expiresInDays: v.number(),
  },
  returns: invite,
  handler: async (ctx, { codeHash, email, role, expiresInDays }) => {
    const viewer = await authorize(ctx, "admin");
    const now = Date.now();

    const inviteId = await ctx.db.insert("invites", {
      codeHash,
      email,
      role,
      createdBy: viewer.userId,
      expiresAt: now + expiresInDays * DAY_MS,
    });

    const created = await ctx.db.get(inviteId);

    if (created === null) return fail("internal", "The invite vanished right after it was created");

    return presentInvite(created, now);
  },
});

/**
 * Creates an invite for an admin or member account, open for 7 days unless `expiresInDays` picks
 * 1 to 30. Requires `admin` scope. The result carries the code and link, never shown again.
 */
export const create = action({
  args: {
    email: v.optional(v.string()),
    role: assignableRole,
    expiresInDays: v.optional(v.number()),
  },
  returns: createdInvite,
  handler: async (ctx, { email, role, expiresInDays }): Promise<Infer<typeof createdInvite>> => {
    const code = randomSecret(18);
    const days = expiresInDays ?? DEFAULT_INVITE_DAYS;

    if (!Number.isInteger(days) || days < 1 || days > 30) {
      return fail("invalid_args", "Invites last from 1 to 30 days");
    }

    const created = await ctx.runMutation(internal.invites.insert, {
      codeHash: await sha256Hex(code),
      email: email?.trim().toLowerCase() ?? null,
      role,
      expiresInDays: days,
    });

    return { invite: created, code, url: `${siteUrl()}/invite/${code}` };
  },
});

/** The 200 most recent invites with their state. Requires `admin` scope. */
export const list = query({
  args: {},
  returns: v.array(invite),
  handler: async (ctx) => {
    await authorize(ctx, "admin");
    const invites = await ctx.db.query("invites").order("desc").take(200);
    const now = Date.now();

    return invites.map((doc) => presentInvite(doc, now));
  },
});

/**
 * Revokes an open invite so its code stops working. Requires `admin` scope; an accepted invite
 * fails with `conflict`.
 */
export const revoke = mutation({
  args: { inviteId: v.id("invites") },
  returns: ok,
  handler: async (ctx, { inviteId }) => {
    await authorize(ctx, "admin");
    const found = await ctx.db.get(inviteId);

    if (found === null) return fail("not_found", "No such invite");

    if (found.acceptedBy !== undefined) return fail("conflict", "This invite was already used");

    await ctx.db.patch(inviteId, { revokedAt: Date.now() });

    return { ok: true as const };
  },
});
