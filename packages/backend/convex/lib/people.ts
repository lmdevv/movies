import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { inSequence } from "./catalog";
import type { ReadCtx } from "./viewer";
import type { credit, externalIds, scannedCredit, scannedPerson } from "./validators";

type ExternalIds = Infer<typeof externalIds>;

const NAMESAKES = 10;

/** Most credits a title or episode keeps; `CREDIT_BATCH_LIMIT` in contracts. */
export const CREDIT_LIMIT = 100;

const normalizeName = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();

/** The key that identifies a person across titles. */
export const personKeyOf = (person: {
  readonly name: string;
  readonly externalIds: ExternalIds;
}): string =>
  person.externalIds.tmdb === null
    ? person.externalIds.imdb === null
      ? `name:${normalizeName(person.name)}`
      : `imdb:${person.externalIds.imdb}`
    : `tmdb:${person.externalIds.tmdb}`;

const sortKeyOf = (name: string): string => {
  const parts = normalizeName(name).split(" ");
  const last = parts.at(-1) ?? "";

  return [last, ...parts.slice(0, -1)].join(" ");
};

const findByKey = (ctx: ReadCtx, personKey: string): Promise<Doc<"people"> | null> =>
  ctx.db
    .query("people")
    .withIndex("by_key", (q) => q.eq("personKey", personKey))
    .first();

const mergeIds = (current: ExternalIds, found: ExternalIds): ExternalIds => ({
  tmdb: current.tmdb ?? found.tmdb,
  imdb: current.imdb ?? found.imdb,
  tvdb: current.tvdb ?? found.tvdb,
});

const compatible = (left: ExternalIds, right: ExternalIds): boolean =>
  (["tmdb", "imdb", "tvdb"] as const).every(
    (provider) =>
      left[provider] === null || right[provider] === null || left[provider] === right[provider],
  );

const upsertPerson = async (
  ctx: MutationCtx,
  person: Infer<typeof scannedPerson>,
): Promise<Doc<"people">> => {
  const name = person.name.trim();
  const key = personKeyOf({ name, externalIds: person.externalIds });

  const namesakes = async (): Promise<Doc<"people"> | null> =>
    (
      await ctx.db
        .query("people")
        .withIndex("by_name", (q) => q.eq("name", name))
        .take(NAMESAKES)
    ).find((candidate) => compatible(candidate.externalIds, person.externalIds)) ?? null;

  const existing = (await findByKey(ctx, key)) ?? (await namesakes());

  if (existing === null) {
    const personId = await ctx.db.insert("people", {
      personKey: key,
      name,
      sortKey: sortKeyOf(name),
      externalIds: person.externalIds,
      profile: person.profile,
      biography: null,
      birthDate: null,
      deathDate: null,
      birthPlace: null,
      knownFor: null,
      detailsFetchedAt: null,
      updatedAt: Date.now(),
    });

    const created = await ctx.db.get(personId);

    if (created === null) throw new Error("A person vanished right after it was created");

    return created;
  }

  const ids = mergeIds(existing.externalIds, person.externalIds);
  const profile = existing.profile ?? person.profile;
  const personKey = personKeyOf({ name: existing.name, externalIds: ids });

  const changed =
    personKey !== existing.personKey ||
    profile !== existing.profile ||
    ids.tmdb !== existing.externalIds.tmdb ||
    ids.imdb !== existing.externalIds.imdb ||
    ids.tvdb !== existing.externalIds.tvdb;

  if (!changed) return existing;
  const patch = { personKey, externalIds: ids, profile, updatedAt: Date.now() };

  await ctx.db.patch(existing._id, patch);

  return { ...existing, ...patch };
};

/** The stored credits of a title (`episodeId` null) or one episode, in billing order. */
export const creditsOf = (
  ctx: ReadCtx,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  limit: number,
): Promise<Array<Doc<"credits">>> =>
  ctx.db
    .query("credits")
    .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", episodeId))
    .take(limit);

/** Replaces the credits of a title or episode and reports each credited person. */
export const replaceCredits = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  credits: ReadonlyArray<Infer<typeof scannedCredit>>,
): Promise<Array<Doc<"people">>> => {
  const previous = await creditsOf(ctx, titleId, episodeId, CREDIT_LIMIT * 2);

  await Promise.all(previous.map((row) => ctx.db.delete(row._id)));

  return inSequence(credits.slice(0, CREDIT_LIMIT), async (entry) => {
    const person = await upsertPerson(ctx, entry.person);

    await ctx.db.insert("credits", {
      titleId,
      episodeId,
      personId: person._id,
      kind: entry.kind,
      role: entry.role,
      order: entry.order,
    });

    return person;
  });
};

/**
 * Removes up to `limit` credits of a title (its own and its episodes'), for when the title goes
 * away. Reports how many it removed; none means none were left.
 */
export const removeTitleCredits = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  limit: number,
): Promise<number> => {
  const rows = await ctx.db
    .query("credits")
    .withIndex("by_title_episode", (q) => q.eq("titleId", titleId))
    .take(limit);

  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

  return rows.length;
};

/**
 * Each group of credits with its people's names and photos, reading each person once across all
 * groups. People removed meanwhile are left out.
 */
export const presentCreditGroups = async (
  ctx: ReadCtx,
  groups: ReadonlyArray<ReadonlyArray<Doc<"credits">>>,
): Promise<Array<Array<Infer<typeof credit>>>> => {
  const ids = [...new Set(groups.flat().map((row) => row.personId))];
  const found = await Promise.all(ids.map((personId) => ctx.db.get(personId)));
  const people = new Map(ids.map((personId, index) => [personId, found[index] ?? null]));

  return groups.map((rows) =>
    rows.flatMap((row) => {
      const person = people.get(row.personId);

      return person === null || person === undefined
        ? []
        : [
            {
              personId: person._id,
              name: person.name,
              kind: row.kind,
              role: row.role,
              profile: person.profile,
              order: row.order,
            },
          ];
    }),
  );
};
