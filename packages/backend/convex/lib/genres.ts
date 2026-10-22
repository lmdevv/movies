import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** A genre as rows store and filters compare it. */
export const genreKey = (genre: string): string => genre.trim().toLowerCase();

/** Makes the title's genre rows match its current genres and sort fields. */
export const syncTitleGenres = async (ctx: MutationCtx, title: Doc<"titles">): Promise<void> => {
  const rows = await ctx.db
    .query("titleGenres")
    .withIndex("by_title", (q) => q.eq("titleId", title._id))
    .collect();

  const wanted = new Set(title.genres.map(genreKey).filter((genre) => genre !== ""));

  const fields = {
    libraryId: title.libraryId,
    kind: title.kind,
    sortKey: title.sortKey,
    addedAt: title.addedAt,
    year: title.year,
  };

  const kept = new Set<string>();

  await Promise.all(
    rows.map(async (row) => {
      if (!wanted.has(row.genre) || kept.has(row.genre)) return ctx.db.delete(row._id);
      kept.add(row.genre);

      const stale =
        row.libraryId !== fields.libraryId ||
        row.kind !== fields.kind ||
        row.sortKey !== fields.sortKey ||
        row.addedAt !== fields.addedAt ||
        row.year !== fields.year;

      return stale ? ctx.db.patch(row._id, fields) : undefined;
    }),
  );

  await Promise.all(
    [...wanted].flatMap((genre) =>
      kept.has(genre)
        ? []
        : [ctx.db.insert("titleGenres", { titleId: title._id, genre, ...fields })],
    ),
  );
};

/** Removes the genre rows of a title that is going away. */
export const removeTitleGenres = async (ctx: MutationCtx, titleId: Id<"titles">): Promise<void> => {
  const rows = await ctx.db
    .query("titleGenres")
    .withIndex("by_title", (q) => q.eq("titleId", titleId))
    .collect();

  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
};
