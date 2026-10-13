/**
 * Pages of titles for `titles.list`. Pages follow an index by position (the sort value and creation
 * time of the last title read) instead of Convex's pagination cursor, so one query can read several
 * batches: a limited profile or a kind filter still gets full pages, up to a read budget, and the
 * cursor always resumes right after the last title read.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { Audience } from "./access";
import { canSee } from "./access";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** Titles one page reads at most; past it the page comes back short with a cursor to continue. */
const READ_BUDGET = 1000;

/** The orders `titles.list` offers: by name ascending, newest added, or newest year. */
export type TitleSort = "name" | "added" | "year";

/** Which titles a page lists: every title, one kind, one library, or one kind in one library. */
export interface TitleScope {
  readonly kind: Doc<"titles">["kind"] | undefined;
  readonly libraryId: Id<"libraries"> | undefined;
}

/** Where a page ended: the last title's sort value and creation time. */
interface Position<Value> {
  readonly value: Value;
  readonly creationTime: number;
}

/**
 * Reads up to `count` titles in order after the position a cursor names, or from the start. A
 * cursor is the last title's creation time and its sort value, as `<creationTime>:<value>`.
 */
type Reader = (cursor: string | null, count: number) => Promise<Array<Doc<"titles">>>;

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

const cursorOf = (title: Doc<"titles">, value: string): string =>
  `${String(title._creationTime)}:${value}`;

/**
 * Where a range starts: the beginning, titles with the cursor's value created after its title,
 * or titles past the cursor's value.
 */
type Bound<Value> =
  | { readonly kind: "start" }
  | { readonly kind: "tie"; readonly value: Value; readonly time: number }
  | { readonly kind: "past"; readonly value: Value };

const titlesOf = (ctx: ReadCtx) => ctx.db.query("titles");

/** A query over titles with an index range chosen, before its order. */
type TitlesQuery = ReturnType<ReturnType<typeof titlesOf>["fullTableScan"]>;

/**
 * One sort order: its direction, how its value reads from a cursor and a title, and its index
 * ranges for each scope. Convex types each index's range by its own field names, so every order
 * spells out its three indexes; everything else is shared by `planOf`.
 */
interface SortSpec<Value> {
  readonly order: "asc" | "desc";
  readonly parse: (text: string) => Value;
  readonly text: (title: Doc<"titles">) => string;
  readonly range: (ctx: ReadCtx, scope: TitleScope, bound: Bound<Value>) => TitlesQuery;
}

/** How a page reads titles in one order, and the cursor that resumes after a title. */
interface SortPlan {
  readonly reader: (ctx: ReadCtx, scope: TitleScope) => Reader;
  readonly cursorAfter: (title: Doc<"titles">) => string;
}

/** Reads from the start, or the cursor's ties and then the titles past its value. */
const planOf = <Value>(spec: SortSpec<Value>): SortPlan => ({
  reader: (ctx, scope) => async (cursor, count) => {
    const read = (bound: Bound<Value>, limit: number) =>
      spec.range(ctx, scope, bound).order(spec.order).take(limit);

    if (cursor === null) return read({ kind: "start" }, count);
    const after = parseCursor(cursor);
    const value = spec.parse(after.value);
    const tied = await read({ kind: "tie", value, time: after.creationTime }, count);

    return tied.length >= count
      ? tied
      : [...tied, ...(await read({ kind: "past", value }, count - tied.length))];
  },
  cursorAfter: (title) => cursorOf(title, spec.text(title)),
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

  const wanted = (title: Doc<"titles">): boolean =>
    canSee(audience, title) && (scope.kind === undefined || title.kind === scope.kind);

  const batchSize = Math.max(numItems * 2, 50);

  const step = async (
    after: string | null,
    items: ReadonlyArray<Doc<"titles">>,
    budget: number,
  ): Promise<{ readonly items: Array<Doc<"titles">>; readonly nextCursor: string | null }> => {
    const count = Math.min(batchSize, budget);
    const batch = await read(after, count);
    const found = [...items];

    for (const title of batch) {
      if (wanted(title)) found.push(title);

      if (found.length === numItems) {
        const last = title === batch.at(-1) && batch.length < count;

        return { items: found, nextCursor: last ? null : plan.cursorAfter(title) };
      }
    }

    const last = batch.at(-1);

    if (last === undefined || batch.length < count) return { items: found, nextCursor: null };
    const position = plan.cursorAfter(last);

    return budget - batch.length <= 0
      ? { items: found, nextCursor: position }
      : step(position, found, budget - batch.length);
  };

  return step(cursor, [], READ_BUDGET);
};
