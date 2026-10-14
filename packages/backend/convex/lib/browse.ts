/**
 * Pages of titles for `titles.list`. Pages follow an index by position (the sort value and creation
 * time of the last row read) instead of Convex's pagination cursor, so one query can read several
 * batches: a limited profile, a kind, or a metadata filter still gets full pages, up to a read
 * budget, and the cursor always resumes right after the last row read. A genre pages through its
 * own `titleGenres` rows, which carry the title's sort fields, so a rare genre reads only its own
 * titles.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { Audience } from "./access";
import { canSee } from "./access";
import type { TitleFilter } from "./discovery";
import { isFiltered, matchesFilter } from "./discovery";
import { fail } from "./errors";
import { genreKey } from "./genres";
import type { ReadCtx } from "./viewer";

/**
 * Documents one page reads at most; past it the page comes back short with a cursor to continue.
 * A genre page reads a genre row and its title for each entry, so it reads half as many entries.
 */
const READ_BUDGET = 1000;

/** The orders `titles.list` offers: by name ascending, newest added, or newest year. */
export type TitleSort = "name" | "added" | "year";

/**
 * Which titles a page lists: every title, one kind, one library, or one kind in one library;
 * only those that pass `filter` (a genre, years, studio, score). A genre reads its own rows.
 */
export interface TitleScope {
  readonly kind: Doc<"titles">["kind"] | undefined;
  readonly libraryId: Id<"libraries"> | undefined;
  readonly filter: TitleFilter;
}

/** A row read in sort order: a title, or a genre row carrying its title's sort fields. */
type Positioned = Pick<Doc<"titles">, "sortKey" | "addedAt" | "year" | "_creationTime">;

/** One row read, with the title it stands for; a genre row's title may be gone. */
interface Entry {
  readonly position: Positioned;
  readonly title: Doc<"titles"> | null;
}

/** Where a page ended: the last title's sort value and creation time. */
interface Position<Value> {
  readonly value: Value;
  readonly creationTime: number;
}

/**
 * Reads up to `count` rows in order after the position a cursor names, or from the start. A
 * cursor is the last row's creation time and its sort value, as `<creationTime>:<value>`.
 */
type Reader = (cursor: string | null, count: number) => Promise<ReadonlyArray<Entry>>;

const CURSOR = /^(?<time>\d+(?:\.\d+)?):(?<value>.*)$/su;

const invalidCursor = (): never => fail("invalid_args", "This page cursor is not valid");

/** Splits a cursor into its creation time and the sort value's text. */
const parseCursor = (cursor: string): Position<string> => {
  const groups = CURSOR.exec(cursor)?.groups;
  const time = Number(groups?.["time"]);
  const value = groups?.["value"];

  return value === undefined || !Number.isFinite(time)
    ? invalidCursor()
    : { value, creationTime: time };
};

const parseNumber = (text: string): number => {
  const parsed = Number(text);

  return text.length > 0 && Number.isFinite(parsed) ? parsed : invalidCursor();
};

const cursorOf = (row: Positioned, value: string): string =>
  `${String(row._creationTime)}:${value}`;

/**
 * Where a range starts: the beginning, titles with the cursor's value created after its title,
 * or titles past the cursor's value.
 */
type Bound<Value> =
  | { readonly kind: "start" }
  | { readonly kind: "tie"; readonly value: Value; readonly time: number }
  | { readonly kind: "past"; readonly value: Value };

const titlesOf = (ctx: ReadCtx) => ctx.db.query("titles");

const genreRowsOf = (ctx: ReadCtx) => ctx.db.query("titleGenres");

/** A query over titles with an index range chosen, before its order. */
type TitlesQuery = ReturnType<ReturnType<typeof titlesOf>["fullTableScan"]>;

/** A query over genre rows with an index range chosen, before its order. */
type GenreQuery = ReturnType<ReturnType<typeof genreRowsOf>["fullTableScan"]>;

/** Which genre rows a page reads: one genre's, in one library, of one kind, or everywhere. */
interface GenreScope {
  readonly kind: Doc<"titles">["kind"] | undefined;
  readonly libraryId: Id<"libraries"> | undefined;
  readonly genre: string;
}

/**
 * One sort order: its direction, how its value reads from a cursor and a row, and its index
 * ranges for each scope. Convex types each index's range by its own field names, so every order
 * spells out its indexes; everything else is shared by `planOf`.
 */
interface SortSpec<Value> {
  readonly order: "asc" | "desc";
  readonly parse: (text: string) => Value;
  readonly text: (row: Positioned) => string;
  readonly range: (ctx: ReadCtx, scope: TitleScope, bound: Bound<Value>) => TitlesQuery;
  readonly genreRange: (ctx: ReadCtx, scope: GenreScope, bound: Bound<Value>) => GenreQuery;
}

/** How a page reads rows in one order, and the cursor that resumes after a row. */
interface SortPlan {
  readonly reader: (ctx: ReadCtx, scope: TitleScope) => Reader;
  readonly cursorAfter: (row: Positioned) => string;
}

/** Reads from the start, or the cursor's ties and then the rows past its value. */
const planOf = <Value>(spec: SortSpec<Value>): SortPlan => ({
  reader: (ctx, scope) => {
    const { genre } = scope.filter;

    const read = async (bound: Bound<Value>, limit: number): Promise<ReadonlyArray<Entry>> => {
      if (genre === undefined) {
        const titles = await spec.range(ctx, scope, bound).order(spec.order).take(limit);

        return titles.map((title) => ({ position: title, title }));
      }

      const rows = await spec
        .genreRange(
          ctx,
          { kind: scope.kind, libraryId: scope.libraryId, genre: genreKey(genre) },
          bound,
        )
        .order(spec.order)
        .take(limit);

      const titles = await Promise.all(rows.map((row) => ctx.db.get(row.titleId)));

      return rows.map((row, index) => ({ position: row, title: titles[index] ?? null }));
    };

    return async (cursor, count) => {
      if (cursor === null) return read({ kind: "start" }, count);
      const after = parseCursor(cursor);
      const value = spec.parse(after.value);
      const tied = await read({ kind: "tie", value, time: after.creationTime }, count);

      return tied.length >= count
        ? tied
        : [...tied, ...(await read({ kind: "past", value }, count - tied.length))];
    };
  },
  cursorAfter: (row) => cursorOf(row, spec.text(row)),
});

const byName = planOf<string>({
  order: "asc",
  parse: (text) => text,
  text: (title) => title.sortKey,
  range: (ctx, { kind, libraryId }, bound) => {
    const titles = titlesOf(ctx);

    if (libraryId !== undefined) {
      return titles.withIndex("by_library_sort", (q) => {
        const scoped = q.eq("libraryId", libraryId);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.gt("sortKey", bound.value);

        return scoped.eq("sortKey", bound.value).gt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return titles.withIndex("by_kind_sort", (q) => {
        const scoped = q.eq("kind", kind);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.gt("sortKey", bound.value);

        return scoped.eq("sortKey", bound.value).gt("_creationTime", bound.time);
      });
    }

    return titles.withIndex("by_sort", (q) => {
      if (bound.kind === "start") return q;

      if (bound.kind === "past") return q.gt("sortKey", bound.value);

      return q.eq("sortKey", bound.value).gt("_creationTime", bound.time);
    });
  },
  genreRange: (ctx, { kind, libraryId, genre }, bound) => {
    const rows = genreRowsOf(ctx);

    if (libraryId !== undefined) {
      return rows.withIndex("by_library_genre_sort", (q) => {
        const scoped = q.eq("libraryId", libraryId).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.gt("sortKey", bound.value);

        return scoped.eq("sortKey", bound.value).gt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return rows.withIndex("by_kind_genre_sort", (q) => {
        const scoped = q.eq("kind", kind).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.gt("sortKey", bound.value);

        return scoped.eq("sortKey", bound.value).gt("_creationTime", bound.time);
      });
    }

    return rows.withIndex("by_genre_sort", (q) => {
      const scoped = q.eq("genre", genre);

      if (bound.kind === "start") return scoped;

      if (bound.kind === "past") return scoped.gt("sortKey", bound.value);

      return scoped.eq("sortKey", bound.value).gt("_creationTime", bound.time);
    });
  },
});

const byAdded = planOf<number>({
  order: "desc",
  parse: parseNumber,
  text: (title) => String(title.addedAt),
  range: (ctx, { kind, libraryId }, bound) => {
    const titles = titlesOf(ctx);

    if (libraryId !== undefined) {
      return titles.withIndex("by_library_added", (q) => {
        const scoped = q.eq("libraryId", libraryId);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("addedAt", bound.value);

        return scoped.eq("addedAt", bound.value).lt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return titles.withIndex("by_kind_added", (q) => {
        const scoped = q.eq("kind", kind);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("addedAt", bound.value);

        return scoped.eq("addedAt", bound.value).lt("_creationTime", bound.time);
      });
    }

    return titles.withIndex("by_added", (q) => {
      if (bound.kind === "start") return q;

      if (bound.kind === "past") return q.lt("addedAt", bound.value);

      return q.eq("addedAt", bound.value).lt("_creationTime", bound.time);
    });
  },
  genreRange: (ctx, { kind, libraryId, genre }, bound) => {
    const rows = genreRowsOf(ctx);

    if (libraryId !== undefined) {
      return rows.withIndex("by_library_genre_added", (q) => {
        const scoped = q.eq("libraryId", libraryId).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("addedAt", bound.value);

        return scoped.eq("addedAt", bound.value).lt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return rows.withIndex("by_kind_genre_added", (q) => {
        const scoped = q.eq("kind", kind).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("addedAt", bound.value);

        return scoped.eq("addedAt", bound.value).lt("_creationTime", bound.time);
      });
    }

    return rows.withIndex("by_genre_added", (q) => {
      const scoped = q.eq("genre", genre);

      if (bound.kind === "start") return scoped;

      if (bound.kind === "past") return scoped.lt("addedAt", bound.value);

      return scoped.eq("addedAt", bound.value).lt("_creationTime", bound.time);
    });
  },
});

// Titles without a year sort below every year, so they come last; an empty value is no year.
const byYear = planOf<number | null>({
  order: "desc",
  parse: (text) => (text === "" ? null : parseNumber(text)),
  text: (title) => (title.year === null ? "" : String(title.year)),
  range: (ctx, { kind, libraryId }, bound) => {
    const titles = titlesOf(ctx);

    if (libraryId !== undefined) {
      return titles.withIndex("by_library_year", (q) => {
        const scoped = q.eq("libraryId", libraryId);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("year", bound.value);

        return scoped.eq("year", bound.value).lt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return titles.withIndex("by_kind_year", (q) => {
        const scoped = q.eq("kind", kind);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("year", bound.value);

        return scoped.eq("year", bound.value).lt("_creationTime", bound.time);
      });
    }

    return titles.withIndex("by_year", (q) => {
      if (bound.kind === "start") return q;

      if (bound.kind === "past") return q.lt("year", bound.value);

      return q.eq("year", bound.value).lt("_creationTime", bound.time);
    });
  },
  genreRange: (ctx, { kind, libraryId, genre }, bound) => {
    const rows = genreRowsOf(ctx);

    if (libraryId !== undefined) {
      return rows.withIndex("by_library_genre_year", (q) => {
        const scoped = q.eq("libraryId", libraryId).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("year", bound.value);

        return scoped.eq("year", bound.value).lt("_creationTime", bound.time);
      });
    }

    if (kind !== undefined) {
      return rows.withIndex("by_kind_genre_year", (q) => {
        const scoped = q.eq("kind", kind).eq("genre", genre);

        if (bound.kind === "start") return scoped;

        if (bound.kind === "past") return scoped.lt("year", bound.value);

        return scoped.eq("year", bound.value).lt("_creationTime", bound.time);
      });
    }

    return rows.withIndex("by_genre_year", (q) => {
      const scoped = q.eq("genre", genre);

      if (bound.kind === "start") return scoped;

      if (bound.kind === "past") return scoped.lt("year", bound.value);

      return scoped.eq("year", bound.value).lt("_creationTime", bound.time);
    });
  },
});

const SORT_PLANS = { name: byName, added: byAdded, year: byYear } as const satisfies {
  readonly [Sort in TitleSort]: SortPlan;
};

/**
 * One page of the titles in `scope` the audience may see, in `sort` order. Reads in batches until
 * the page is full, the titles run out, or the read budget is spent; the cursor continues after
 * the last title read, so a short page never skips or repeats a title.
 */
export const listTitles = async (
  ctx: ReadCtx,
  audience: Audience,
  scope: TitleScope,
  sort: TitleSort,
  cursor: string | null,
  numItems: number,
): Promise<{ readonly items: Array<Doc<"titles">>; readonly nextCursor: string | null }> => {
  if (scope.libraryId !== undefined && !audience.libraryIds.has(scope.libraryId)) {
    return { items: [], nextCursor: null };
  }

  const plan = SORT_PLANS[sort];
  const read = plan.reader(ctx, scope);

  const filtered = isFiltered(scope.filter);

  // A genre page in one library reads that library's rows of every kind, so its titles are
  // checked against the kind; every page checks the library too, which costs nothing.
  const wanted = (title: Doc<"titles"> | null): title is Doc<"titles"> =>
    title !== null &&
    canSee(audience, title) &&
    (scope.kind === undefined || title.kind === scope.kind) &&
    (scope.libraryId === undefined || title.libraryId === scope.libraryId) &&
    (!filtered || matchesFilter(scope.filter, title));

  // The first batch reads one row past a full page, which a profile that sees everything fills
  // while still telling whether more follow; later batches read more, as filtering is likely.
  const batchSize = Math.max(numItems * 2, 50);

  const step = async (
    after: string | null,
    items: ReadonlyArray<Doc<"titles">>,
    budget: number,
    size: number,
  ): Promise<{ readonly items: Array<Doc<"titles">>; readonly nextCursor: string | null }> => {
    const count = Math.min(size, budget);
    const batch = await read(after, count);
    const found = [...items];

    for (const entry of batch) {
      if (wanted(entry.title)) found.push(entry.title);

      if (found.length === numItems) {
        const last = entry === batch.at(-1) && batch.length < count;

        return { items: found, nextCursor: last ? null : plan.cursorAfter(entry.position) };
      }
    }

    const last = batch.at(-1);

    if (last === undefined || batch.length < count) return { items: found, nextCursor: null };
    const position = plan.cursorAfter(last.position);

    return budget - batch.length <= 0
      ? { items: found, nextCursor: position }
      : step(position, found, budget - batch.length, batchSize);
  };

  const budget = scope.filter.genre === undefined ? READ_BUDGET : READ_BUDGET / 2;

  return step(cursor, [], budget, numItems + 1);
};
