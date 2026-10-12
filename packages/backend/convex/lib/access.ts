/**
 * Profile ownership, PIN unlock, library grants, and rating limits. A profile-scoped read builds an
 * `Audience` once and filters every title through it; hidden titles look like missing ones, so a
 * kids profile never learns what it cannot see.
 */
import type { Doc, Id } from "../_generated/dataModel";
import { fail } from "./errors";
import { isAdminRole } from "./scopes";
import type { ReadCtx, Viewer } from "./viewer";

/** Whether this session unlocked the profile, or it has no PIN. */
export const isProfileUnlocked = (viewer: Viewer, profile: Doc<"profiles">): boolean =>
  profile.pinHash === undefined || (viewer.session.unlockedProfiles ?? []).includes(profile._id);

/** Loads one of the viewer's own profiles, PIN-locked or not. Other accounts' profiles are `not_found`. */
export const loadOwnProfile = async (
  ctx: ReadCtx,
  viewer: Viewer,
  profileId: Id<"profiles">,
): Promise<Doc<"profiles">> => {
  const profile = await ctx.db.get(profileId);

  if (profile?.userId !== viewer.userId) return fail("not_found", "No such profile");

  return profile;
};

/** Loads one of the viewer's profiles and requires it to be unlocked on this session. */
export const loadUnlockedProfile = async (
  ctx: ReadCtx,
  viewer: Viewer,
  profileId: Id<"profiles">,
): Promise<Doc<"profiles">> => {
  const profile = await loadOwnProfile(ctx, viewer, profileId);

  if (!isProfileUnlocked(viewer, profile)) {
    return fail("forbidden", "Unlock this profile with its PIN first");
  }

  return profile;
};

/**
 * The libraries an account may see: every library for admins; for members, `everyone` libraries
 * and the `restricted` ones they were granted.
 */
export const visibleLibraryIds = async (
  ctx: ReadCtx,
  viewer: Viewer,
): Promise<ReadonlySet<Id<"libraries">>> => {
  const libraries = await ctx.db.query("libraries").collect();

  if (isAdminRole(viewer.user.role)) return new Set(libraries.map((library) => library._id));

  const grants = await ctx.db
    .query("libraryGrants")
    .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
    .collect();

  const granted = new Set(grants.map((grant) => grant.libraryId));

  return new Set(
    libraries.flatMap((library) =>
      library.access === "everyone" || granted.has(library._id) ? [library._id] : [],
    ),
  );
};

/** One unlocked profile and what it may see. */
export interface Audience {
  readonly viewer: Viewer;
  readonly profile: Doc<"profiles">;
  readonly libraryIds: ReadonlySet<Id<"libraries">>;
}

/** Loads an unlocked profile and the libraries its account may see. */
export const loadAudience = async (
  ctx: ReadCtx,
  viewer: Viewer,
  profileId: Id<"profiles">,
): Promise<Audience> => ({
  viewer,
  profile: await loadUnlockedProfile(ctx, viewer, profileId),
  libraryIds: await visibleLibraryIds(ctx, viewer),
});

/** A title's age rating after admin overrides. */
export const titleAgeRating = (title: Doc<"titles">): number | null =>
  title.overrides?.ageRating ?? title.ageRating;

/**
 * Whether the profile may see a title: its library is visible and, for a profile with a rating
 * limit, the title is rated at most that age. Unrated titles stay hidden from limited profiles.
 */
export const canSee = (audience: Audience, title: Doc<"titles">): boolean => {
  if (!audience.libraryIds.has(title.libraryId)) return false;
  const limit = audience.profile.maxAgeRating;

  if (limit === null) return true;
  const age = titleAgeRating(title);

  return age !== null && age <= limit;
};

/** Loads a title the profile may see, or fails with `not_found` exactly as for a missing one. */
export const loadVisibleTitle = async (
  ctx: ReadCtx,
  audience: Audience,
  titleId: Id<"titles">,
): Promise<Doc<"titles">> => {
  const title = await ctx.db.get(titleId);

  if (title === null || !canSee(audience, title)) return fail("not_found", "No such title");

  return title;
};
