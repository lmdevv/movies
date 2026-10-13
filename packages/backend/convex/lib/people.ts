/**
 * People and their credits. A person is found by `personKey` (TMDB, then IMDb, then a normalized
 * name), so the same actor across titles is one row. Credits of a title, or of one episode, are
 * replaced as a set whenever their digest changes.
 */
import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { inSequence } from "./catalog";
import type { ReadCtx } from "./viewer";
import type { credit, externalIds, scannedCredit, scannedPerson } from "./validators";

type ExternalIds = Infer<typeof externalIds>;

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

/** Sorts by family name the way credits lists usually do: "Villeneuve denis". */
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

/**
 * Finds or creates the person a credit names. A person known only by name gains provider IDs (and
 * a better key) when a later credit carries them; a photo fills in only where none is stored.
 */
export const upsertPerson = async (
  ctx: MutationCtx,
  person: Infer<typeof scannedPerson>,
): Promise<Doc<"people">> => {
  const name = person.name.trim();
  const key = personKeyOf({ name, externalIds: person.externalIds });
  const nameKey = personKeyOf({ name, externalIds: { tmdb: null, imdb: null, tvdb: null } });

  const existing =
    (await findByKey(ctx, key)) ??
    (key === nameKey
      ? null
      : await findByKey(ctx, nameKey).then((named) =>
          // Only a person nobody has identified may be upgraded, or two namesakes would merge.
          named !== null && named.externalIds.tmdb === null && named.externalIds.imdb === null
            ? named
            : null,
        ));

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

  // In order: a person credited twice (director and writer) must be found, not created twice.
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
 * away. Reports whether none are left.
 */
export const removeTitleCredits = async (
  ctx: MutationCtx,
  titleId: Id<"titles">,
  limit: number,
): Promise<boolean> => {
  const rows = await ctx.db
    .query("credits")
    .withIndex("by_title_episode", (q) => q.eq("titleId", titleId))
    .take(limit + 1);

  await Promise.all(rows.slice(0, limit).map((row) => ctx.db.delete(row._id)));

  return rows.length <= limit;
};

/** A credit with its person's name and photo. People removed meanwhile are left out. */
export const presentCredits = async (
  ctx: ReadCtx,
  rows: ReadonlyArray<Doc<"credits">>,
): Promise<Array<Infer<typeof credit>>> => {
  const people = await Promise.all(rows.map((row) => ctx.db.get(row.personId)));

  return rows.flatMap((row, index) => {
    const person = people[index];

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
  });
};
