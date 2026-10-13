/**
 * Cast and crew for one profile. A person appears only through titles the profile may see: one
 * credited only on hidden titles looks missing, exactly like a hidden title.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { Audience } from "./lib/access";
import { canSee, loadAudience } from "./lib/access";
import { fail } from "./lib/errors";
import { enqueueJob } from "./lib/jobs";
import { presentTitleCard } from "./lib/present";
import { ok, personCard, personDetail } from "./lib/validators";
import type { ReadCtx } from "./lib/viewer";
import { authorize } from "./lib/viewer";

/** Credits read for one person page. */
const CREDIT_SCAN = 500;

/** People the search index returns before visibility filtering. */
const SEARCH_SCAN = 50;

/** Credits checked per search hit to find one the profile may see. */
const SEARCH_CREDIT_SCAN = 10;

/** How long a details request waits before another may queue a job for the same person. */
const REQUEST_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Departments ordered for a person page: acting first, then who made the title. */
const KIND_RANK: Readonly<Record<Doc<"credits">["kind"], number>> = {
  actor: 0,
  "guest-star": 1,
  creator: 2,
  director: 3,
  writer: 4,
  producer: 5,
  composer: 6,
};

/** A person's credits on titles the profile may see, one entry per title and kind. */
const visibleCredits = async (
  ctx: ReadCtx,
  audience: Audience,
  personId: Id<"people">,
  limit: number,
) => {
  const rows = await ctx.db
    .query("credits")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(limit);

  const titleIds = [...new Set(rows.map((row) => row.titleId))];
  const titles = await Promise.all(titleIds.map((titleId) => ctx.db.get(titleId)));

  const visible = new Map(
    titles.flatMap((title) =>
      title !== null && canSee(audience, title) ? [[title._id, title] as const] : [],
    ),
  );

  const grouped = new Map<
    string,
    { title: Doc<"titles">; kind: Doc<"credits">["kind"]; role: string | null; episodes: number }
  >();

  for (const row of rows) {
    const title = visible.get(row.titleId);

    if (title === undefined) continue;
    const key = `${row.titleId}:${row.kind}`;
    const entry = grouped.get(key);

    if (entry === undefined) {
      grouped.set(key, {
        title,
        kind: row.kind,
        role: row.role,
        episodes: row.episodeId === null ? 0 : 1,
      });
    } else {
      entry.role ??= row.role;

      if (row.episodeId !== null) entry.episodes += 1;
    }
  }

  return [...grouped.values()];
};

const yearOf = (title: Doc<"titles">): number => title.overrides?.year ?? title.year ?? 0;

export const get = query({
  args: { profileId: v.id("profiles"), personId: v.id("people") },
  returns: personDetail,
  handler: async (ctx, { profileId, personId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const person = await ctx.db.get(personId);

    if (person === null) return fail("not_found", "No such person");
    const credits = await visibleCredits(ctx, audience, personId, CREDIT_SCAN);

    if (credits.length === 0) return fail("not_found", "No such person");

    return {
      id: person._id,
      name: person.name,
      profile: person.profile,
      externalIds: person.externalIds,
      biography: person.biography,
      birthDate: person.birthDate,
      deathDate: person.deathDate,
      birthPlace: person.birthPlace,
      knownFor: person.knownFor,
      detailsPending: person.detailsFetchedAt === null && person.externalIds.tmdb !== null,
      credits: credits
        .toSorted(
          (left, right) =>
            yearOf(right.title) - yearOf(left.title) ||
            KIND_RANK[left.kind] - KIND_RANK[right.kind],
        )
        .map((entry) => ({
          title: presentTitleCard(entry.title),
          kind: entry.kind,
          role: entry.role,
          episodeCount: entry.episodes,
        })),
    };
  },
});

/** People whose names match, among those credited on a title the profile may see. */
export const search = query({
  args: { profileId: v.id("profiles"), query: v.string(), limit: v.optional(v.number()) },
  returns: v.array(personCard),
  handler: async (ctx, { profileId, query: text, limit }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const wanted = Math.min(Math.max(1, Math.floor(limit ?? 10)), 50);

    if (text.trim().length === 0) return [];

    const matches = await ctx.db
      .query("people")
      .withSearchIndex("search_name", (q) => q.search("name", text.trim()))
      .take(SEARCH_SCAN);

    const visible = await Promise.all(
      matches.map(
        async (person) =>
          (await visibleCredits(ctx, audience, person._id, SEARCH_CREDIT_SCAN)).length > 0,
      ),
    );

    return matches
      .filter((_, index) => visible[index] === true)
      .slice(0, wanted)
      .map((person) => ({
        id: person._id,
        name: person.name,
        profile: person.profile,
        knownFor: person.knownFor,
      }));
  },
});

/**
 * Queues a person job when a person page opens without a biography. One request per person
 * every six hours queues at most one job, so opening a page repeatedly costs nothing.
 */
export const requestDetails = mutation({
  args: { profileId: v.id("profiles"), personId: v.id("people") },
  returns: ok,
  handler: async (ctx, { profileId, personId }) => {
    const viewer = await authorize(ctx, "read");
    const audience = await loadAudience(ctx, viewer, profileId);
    const person = await ctx.db.get(personId);

    if (person === null) return fail("not_found", "No such person");

    if ((await visibleCredits(ctx, audience, personId, CREDIT_SCAN)).length === 0) {
      return fail("not_found", "No such person");
    }

    const now = Date.now();

    const due =
      person.detailsFetchedAt === null &&
      person.externalIds.tmdb !== null &&
      (person.detailsRequestedAt === undefined ||
        now - person.detailsRequestedAt >= REQUEST_COOLDOWN_MS);

    if (due) {
      await ctx.db.patch(personId, { detailsRequestedAt: now });
      await enqueueJob(ctx, { kind: "person", personId }, viewer.userId);
    }

    return { ok: true as const };
  },
});
