/**
 * Device sign-in. A device asks for a code pair, shows the short user code (and a QR link to the
 * approval page), and watches `status` with its secret device code. A signed-in account approves
 * the user code with chosen scopes; the device then signs in once with provider `device`. Codes
 * expire after ten minutes and work once.
 */
import { v } from "convex/values";
import type { Infer } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { checkDisplayName } from "./lib/bounds";
import { normalizeUserCode, randomSecret, randomUserCode, sha256Hex } from "./lib/crypto";
import { siteUrl } from "./lib/env";
import { fail } from "./lib/errors";
import {
  deviceCodeLookup,
  deviceCodeRequest,
  deviceCodeState,
  deviceScope,
  ok,
} from "./lib/validators";
import { authorize } from "./lib/viewer";

/** How long a device code stays usable. */
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;

/** Device sessions last as long as Convex Auth's default sessions. */
const DEVICE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Most unexpired codes waiting at once, so anonymous requests cannot flood the table. */
const MAX_PENDING_CODES = 50;

const stateOf = (doc: Doc<"deviceCodes">, now: number): Doc<"deviceCodes">["status"] =>
  (doc.status === "pending" || doc.status === "approved") && doc.expiresAt <= now
    ? "expired"
    : doc.status;

/** Stores a new code pair; `request` minted the secrets with real randomness. */
export const insert = internalMutation({
  args: { deviceCodeHash: v.string(), userCode: v.string(), clientName: v.string() },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, { deviceCodeHash, userCode, clientName }) => {
    const now = Date.now();

    const waiting = await ctx.db
      .query("deviceCodes")
      .withIndex("by_expires", (q) => q.gt("expiresAt", now))
      .take(MAX_PENDING_CODES + 1);

    if (waiting.length > MAX_PENDING_CODES) {
      return fail(
        "rate_limited",
        "Too many device sign-ins are waiting; try again in a few minutes",
      );
    }

    if (waiting.some((doc) => doc.userCode === userCode)) {
      return fail("conflict", "That code is taken; request another");
    }

    const expiresAt = now + DEVICE_CODE_TTL_MS;

    await ctx.db.insert("deviceCodes", {
      deviceCodeHash,
      userCode,
      clientName: checkDisplayName(clientName, "Device names"),
      status: "pending",
      expiresAt,
    });

    return { expiresAt };
  },
});

export const request = action({
  args: { clientName: v.string() },
  returns: deviceCodeRequest,
  handler: async (ctx, { clientName }): Promise<Infer<typeof deviceCodeRequest>> => {
    const deviceCode = randomSecret(32);
    const userCode = randomUserCode();

    const { expiresAt } = await ctx.runMutation(internal.deviceAuth.insert, {
      deviceCodeHash: await sha256Hex(deviceCode),
      userCode,
      clientName,
    });

    return {
      deviceCode,
      userCode,
      verificationUrl: `${siteUrl()}/device?code=${userCode}`,
      expiresAt,
    };
  },
});

/** Where a device sign-in stands. Public: only the device holds its secret code. */
export const status = query({
  args: { deviceCode: v.string() },
  returns: v.object({ state: deviceCodeState }),
  handler: async (ctx, { deviceCode }) => {
    const deviceCodeHash = await sha256Hex(deviceCode);

    const found = await ctx.db
      .query("deviceCodes")
      .withIndex("by_hash", (q) => q.eq("deviceCodeHash", deviceCodeHash))
      .unique();

    return { state: found === null ? "expired" : stateOf(found, Date.now()) };
  },
});

const findByUserCode = async (ctx: QueryCtx, typed: string): Promise<Doc<"deviceCodes">> => {
  const userCode = normalizeUserCode(typed);

  const found = await ctx.db
    .query("deviceCodes")
    .withIndex("by_user_code", (q) => q.eq("userCode", userCode))
    .order("desc")
    .first();

  return found ?? fail("not_found", "No device is waiting for that code");
};

export const lookup = query({
  args: { userCode: v.string() },
  returns: deviceCodeLookup,
  handler: async (ctx, { userCode }) => {
    await authorize(ctx, "account");
    const found = await findByUserCode(ctx, userCode);

    return {
      userCode: found.userCode,
      clientName: found.clientName,
      state: stateOf(found, Date.now()),
      requestedAt: Math.floor(found._creationTime),
      expiresAt: found.expiresAt,
    };
  },
});

const pendingCode = async (ctx: QueryCtx, userCode: string): Promise<Doc<"deviceCodes">> => {
  const found = await findByUserCode(ctx, userCode);
  const state = stateOf(found, Date.now());

  if (state === "expired")
    return fail("expired", "This code has expired; start again on the device");

  if (state !== "pending") return fail("conflict", "This code was already used");

  return found;
};

export const approve = mutation({
  args: { userCode: v.string(), scopes: v.array(deviceScope) },
  returns: ok,
  handler: async (ctx, { userCode, scopes }) => {
    const viewer = await authorize(ctx, "account");
    const found = await pendingCode(ctx, userCode);
    const requested = [...new Set(scopes)];

    if (requested.length === 0) return fail("invalid_args", "Choose at least one scope");

    const missing = requested.filter((wanted) => !viewer.scopes.has(wanted));

    if (missing.length > 0) {
      return fail("forbidden", `This session cannot grant ${missing.join(", ")}`);
    }

    await ctx.db.patch(found._id, {
      status: "approved",
      decidedBy: viewer.userId,
      scopes: requested,
    });

    return { ok: true as const };
  },
});

export const deny = mutation({
  args: { userCode: v.string() },
  returns: ok,
  handler: async (ctx, { userCode }) => {
    const viewer = await authorize(ctx, "account");
    const found = await pendingCode(ctx, userCode);
    await ctx.db.patch(found._id, { status: "denied", decidedBy: viewer.userId });

    return { ok: true as const };
  },
});

/**
 * Signs in with an approved device code for the `device` provider: consumes it in this
 * transaction and opens a session bound to the approved scopes. Returns null to refuse, including
 * every use after the first.
 */
export const redeem = internalMutation({
  args: { deviceCode: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), sessionId: v.id("authSessions") })),
  handler: async (ctx, { deviceCode }) => {
    const deviceCodeHash = await sha256Hex(deviceCode);

    const found = await ctx.db
      .query("deviceCodes")
      .withIndex("by_hash", (q) => q.eq("deviceCodeHash", deviceCodeHash))
      .unique();

    const now = Date.now();

    if (
      found === null ||
      stateOf(found, now) !== "approved" ||
      found.decidedBy === undefined ||
      found.scopes === undefined
    ) {
      return null;
    }

    const approver = await ctx.db.get(found.decidedBy);

    if (approver === null || approver.disabledAt !== undefined) return null;

    const sessionId = await ctx.db.insert("authSessions", {
      userId: approver._id,
      expirationTime: now + DEVICE_SESSION_MS,
      grant: {
        kind: "device",
        scopes: found.scopes,
        label: found.clientName,
        deviceCodeId: found._id,
      },
    });

    await ctx.db.patch(found._id, { status: "consumed", consumedAt: now });

    return { userId: approver._id, sessionId };
  },
});
