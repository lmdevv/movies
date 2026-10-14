/**
 * Profiles belong to one account. A PIN profile must be unlocked on each session before anything
 * reads or changes it; the unlock lives on the session row and ends with it.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { loadOwnProfile, loadUnlockedProfile } from "./lib/access";
import { checkAgeRating, checkAvatar, checkDisplayName, KIDS_DEFAULT_MAX_AGE } from "./lib/bounds";
import { constantTimeEqual, hashPin, randomSecret } from "./lib/crypto";
import { endProfilePlayback } from "./lib/endings";
import { fail } from "./lib/errors";
import { presentProfile } from "./lib/present";
import { nullable, ok, profile, unlockResult } from "./lib/validators";
import type { Viewer } from "./lib/viewer";
import { authorize } from "./lib/viewer";

/** Most profiles one account may have. */
const MAX_PROFILES = 10;

/** Wrong PINs in a row before the profile locks. */
const MAX_PIN_FAILURES = 5;

const PIN_LOCKOUT_MS = 5 * 60 * 1000;

const PIN_PATTERN = /^\d{4,8}$/u;

const checkName = (name: string): string => checkDisplayName(name, "Profile names");

/**
 * The rating limit after an update. A kids profile always has one: turning kids on without a
 * limit applies the default, and clearing the limit requires turning kids off.
 */
const nextAgeRating = (
  current: Doc<"profiles">,
  kids: boolean | undefined,
  maxAgeRating: number | null | undefined,
): number | null => {
  // Profiles stored before kids profiles always had a limit can still be renamed as they are.
  if (kids === undefined && maxAgeRating === undefined) return current.maxAgeRating;
  const nextKids = kids ?? current.kids;

  const requested =
    maxAgeRating === undefined
      ? kids === true && !current.kids
        ? (current.maxAgeRating ?? KIDS_DEFAULT_MAX_AGE)
        : current.maxAgeRating
      : checkAgeRating(maxAgeRating);

  if (nextKids && requested === null) {
    return fail("invalid_args", "A kids profile needs an age limit; turn kids off to clear it");
  }

  return requested;
};

const setUnlocked = async (
  ctx: MutationCtx,
  viewer: Viewer,
  profileDoc: Doc<"profiles">,
  unlocked: boolean,
): Promise<void> => {
  const others = (viewer.session.unlockedProfiles ?? []).filter((id) => id !== profileDoc._id);

  await ctx.db.patch(viewer.session._id, {
    unlockedProfiles: unlocked ? [...others, profileDoc._id] : others,
  });
};

/** The account's profiles, each marked locked or unlocked for this session. */
export const list = query({
  args: {},
  returns: v.array(profile),
  handler: async (ctx) => {
    const viewer = await authorize(ctx, "read");

    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
      .collect();

    return profiles.map((doc) => presentProfile(viewer, doc));
  },
});

/**
 * Adds a profile to the account. Requires `account` scope. A kids profile gets the default age
 * limit unless one is given; an eleventh profile fails with `conflict`.
 */
export const create = mutation({
  args: {
    name: v.string(),
    avatar: v.string(),
    kids: v.boolean(),
    maxAgeRating: v.optional(nullable(v.number())),
  },
  returns: profile,
  handler: async (ctx, { name, avatar, kids, maxAgeRating }) => {
    const viewer = await authorize(ctx, "account");

    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
      .collect();

    if (existing.length >= MAX_PROFILES) {
      return fail("conflict", `An account can have at most ${MAX_PROFILES} profiles`);
    }

    const profileId = await ctx.db.insert("profiles", {
      userId: viewer.userId,
      name: checkName(name),
      avatar: checkAvatar(avatar),
      kids,
      maxAgeRating: checkAgeRating(maxAgeRating ?? (kids ? KIDS_DEFAULT_MAX_AGE : null)),
      pinFailures: 0,
    });

    return presentProfile(viewer, await loadOwnProfile(ctx, viewer, profileId));
  },
});

/**
 * Renames a profile or changes its avatar, kids setting, or age limit. Requires `account` scope and
 * the profile unlocked on this session. A kids profile keeps an age limit; clearing it requires
 * turning kids off.
 */
export const update = mutation({
  args: {
    profileId: v.id("profiles"),
    name: v.optional(v.string()),
    avatar: v.optional(v.string()),
    kids: v.optional(v.boolean()),
    maxAgeRating: v.optional(nullable(v.number())),
  },
  returns: profile,
  handler: async (ctx, { profileId, name, avatar, kids, maxAgeRating }) => {
    const viewer = await authorize(ctx, "account");
    const current = await loadUnlockedProfile(ctx, viewer, profileId);

    await ctx.db.patch(profileId, {
      name: name === undefined ? current.name : checkName(name),
      avatar: avatar === undefined ? current.avatar : checkAvatar(avatar),
      kids: kids ?? current.kids,
      maxAgeRating: nextAgeRating(current, kids, maxAgeRating),
    });

    return presentProfile(viewer, await loadOwnProfile(ctx, viewer, profileId));
  },
});

/**
 * Deletes a profile with its watch history and list, and ends its playback and room memberships,
 * ending rooms it hosts. Requires `account` scope and the profile unlocked; the last profile fails
 * with `conflict`.
 */
export const remove = mutation({
  args: { profileId: v.id("profiles") },
  returns: ok,
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "account");
    const removed = await loadUnlockedProfile(ctx, viewer, profileId);

    const siblings = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
      .take(2);

    if (siblings.length < 2) return fail("conflict", "An account keeps at least one profile");

    const progress = await ctx.db
      .query("watchProgress")
      .withIndex("by_profile_played", (q) => q.eq("profileId", profileId))
      .collect();

    const listed = await ctx.db
      .query("myList")
      .withIndex("by_profile_added", (q) => q.eq("profileId", profileId))
      .collect();

    await endProfilePlayback(ctx, removed, Date.now());
    await Promise.all([...progress, ...listed].map((doc) => ctx.db.delete(doc._id)));
    await ctx.db.delete(profileId);

    return { ok: true as const };
  },
});

/**
 * Sets a 4 to 8 digit PIN on a profile, or clears it with null. Requires `account` scope and the
 * profile unlocked. This session stays unlocked; other sessions that already unlocked the profile
 * stay unlocked too, and the rest must enter the new PIN.
 */
export const setPin = mutation({
  args: { profileId: v.id("profiles"), pin: nullable(v.string()) },
  returns: ok,
  handler: async (ctx, { profileId, pin }) => {
    const viewer = await authorize(ctx, "account");
    const current = await loadUnlockedProfile(ctx, viewer, profileId);

    if (pin === null) {
      await ctx.db.patch(profileId, {
        pinHash: undefined,
        pinSalt: undefined,
        pinFailures: 0,
        pinLockedUntil: undefined,
      });

      return { ok: true as const };
    }

    if (!PIN_PATTERN.test(pin)) return fail("invalid_args", "A PIN has 4 to 8 digits");
    const pinSalt = randomSecret(16);

    await ctx.db.patch(profileId, {
      pinHash: await hashPin(pin, pinSalt),
      pinSalt,
      pinFailures: 0,
      pinLockedUntil: undefined,
    });

    // The session that set the PIN stays unlocked; every other session must enter it.
    await setUnlocked(ctx, viewer, current, true);

    return { ok: true as const };
  },
});

/**
 * Unlocks a PIN profile for this session. Wrong PINs return a result instead of failing, so the
 * attempt is counted; five in a row lock the profile for five minutes on every session.
 */
export const unlock = mutation({
  args: { profileId: v.id("profiles"), pin: v.string() },
  returns: unlockResult,
  handler: async (ctx, { profileId, pin }) => {
    const viewer = await authorize(ctx, "read");
    const current = await loadOwnProfile(ctx, viewer, profileId);
    const now = Date.now();

    if (current.pinHash === undefined || current.pinSalt === undefined) {
      return { status: "unlocked" as const };
    }

    if (current.pinLockedUntil !== undefined && current.pinLockedUntil > now) {
      return { status: "locked_out" as const, retryAt: current.pinLockedUntil };
    }

    if (constantTimeEqual(await hashPin(pin, current.pinSalt), current.pinHash)) {
      await ctx.db.patch(profileId, { pinFailures: 0, pinLockedUntil: undefined });
      await setUnlocked(ctx, viewer, current, true);

      return { status: "unlocked" as const };
    }

    const failures = current.pinFailures + 1;

    if (failures >= MAX_PIN_FAILURES) {
      const retryAt = now + PIN_LOCKOUT_MS;
      await ctx.db.patch(profileId, { pinFailures: 0, pinLockedUntil: retryAt });

      return { status: "locked_out" as const, retryAt };
    }

    await ctx.db.patch(profileId, { pinFailures: failures });

    return { status: "wrong_pin" as const, attemptsLeft: MAX_PIN_FAILURES - failures };
  },
});

/** Locks a profile on this session again, so its PIN is needed before it is used here. */
export const lock = mutation({
  args: { profileId: v.id("profiles") },
  returns: ok,
  handler: async (ctx, { profileId }) => {
    const viewer = await authorize(ctx, "read");
    const current = await loadOwnProfile(ctx, viewer, profileId);
    await setUnlocked(ctx, viewer, current, false);

    return { ok: true as const };
  },
});
