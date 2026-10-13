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

/** Titles with the cursor's value created after it, then titles past that value. */
const continueAfter = async (
  tie: () => Promise<Array<Doc<"titles">>>,
  rest: (count: number) => Promise<Array<Doc<"titles">>>,
  count: number,
): Promise<Array<Doc<"titles">>> => {
  const tied = await tie();

  return tied.length >= count ? tied : [...tied, ...(await rest(count - tied.length))];
};

const nameReader =
  (ctx: ReadCtx, { kind, libraryId }: TitleScope): Reader =>
  async (cursor, count) => {
    const titles = ctx.db.query("titles");

    if (cursor === null) {
      const start =
        libraryId !== undefined
          ? titles.withIndex("by_library_sort", (q) => q.eq("libraryId", libraryId))
          : kind === undefined
            ? titles.withIndex("by_sort")
            : titles.withIndex("by_kind_sort", (q) => q.eq("kind", kind));

      return start.order("asc").take(count);
    }

    const { value, creationTime: time } = parseCursor(cursor);

    return continueAfter(
      () =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_sort", (q) =>
              q.eq("libraryId", libraryId).eq("sortKey", value).gt("_creationTime", time),
            )
          : kind === undefined
            ? titles.withIndex("by_sort", (q) => q.eq("sortKey", value).gt("_creationTime", time))
            : titles.withIndex("by_kind_sort", (q) =>
                q.eq("kind", kind).eq("sortKey", value).gt("_creationTime", time),
              )
        )
          .order("asc")
          .take(count),
      (left) =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_sort", (q) =>
              q.eq("libraryId", libraryId).gt("sortKey", value),
            )
          : kind === undefined
            ? titles.withIndex("by_sort", (q) => q.gt("sortKey", value))
            : titles.withIndex("by_kind_sort", (q) => q.eq("kind", kind).gt("sortKey", value))
        )
          .order("asc")
          .take(left),
      count,
    );
  };

const addedReader =
  (ctx: ReadCtx, { kind, libraryId }: TitleScope): Reader =>
  async (cursor, count) => {
    const titles = ctx.db.query("titles");

    if (cursor === null) {
      const start =
        libraryId !== undefined
          ? titles.withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
          : kind === undefined
            ? titles.withIndex("by_added")
            : titles.withIndex("by_kind_added", (q) => q.eq("kind", kind));

      return start.order("desc").take(count);
    }

    const after = parseCursor(cursor);
    const value = parseNumber(after.value);
    const time = after.creationTime;

    return continueAfter(
      () =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_added", (q) =>
              q.eq("libraryId", libraryId).eq("addedAt", value).lt("_creationTime", time),
            )
          : kind === undefined
            ? titles.withIndex("by_added", (q) => q.eq("addedAt", value).lt("_creationTime", time))
            : titles.withIndex("by_kind_added", (q) =>
                q.eq("kind", kind).eq("addedAt", value).lt("_creationTime", time),
              )
        )
          .order("desc")
          .take(count),
      (left) =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_added", (q) =>
              q.eq("libraryId", libraryId).lt("addedAt", value),
            )
          : kind === undefined
            ? titles.withIndex("by_added", (q) => q.lt("addedAt", value))
            : titles.withIndex("by_kind_added", (q) => q.eq("kind", kind).lt("addedAt", value))
        )
          .order("desc")
          .take(left),
      count,
    );
  };

const yearReader =
  (ctx: ReadCtx, { kind, libraryId }: TitleScope): Reader =>
  async (cursor, count) => {
    const titles = ctx.db.query("titles");

    if (cursor === null) {
      const start =
        libraryId !== undefined
          ? titles.withIndex("by_library_year", (q) => q.eq("libraryId", libraryId))
          : kind === undefined
            ? titles.withIndex("by_year")
            : titles.withIndex("by_kind_year", (q) => q.eq("kind", kind));

      return start.order("desc").take(count);
    }

    const after = parseCursor(cursor);
    // An empty value is a title without a year.
    const value = after.value === "" ? null : parseNumber(after.value);
    const time = after.creationTime;

    // Titles without a year sort below every year, so they come last.
    return continueAfter(
      () =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_year", (q) =>
              q.eq("libraryId", libraryId).eq("year", value).lt("_creationTime", time),
            )
          : kind === undefined
            ? titles.withIndex("by_year", (q) => q.eq("year", value).lt("_creationTime", time))
            : titles.withIndex("by_kind_year", (q) =>
                q.eq("kind", kind).eq("year", value).lt("_creationTime", time),
              )
        )
          .order("desc")
          .take(count),
      (left) =>
        (libraryId !== undefined
          ? titles.withIndex("by_library_year", (q) =>
              q.eq("libraryId", libraryId).lt("year", value),
            )
          : kind === undefined
            ? titles.withIndex("by_year", (q) => q.lt("year", value))
            : titles.withIndex("by_kind_year", (q) => q.eq("kind", kind).lt("year", value))
        )
          .order("desc")
          .take(left),
      count,
    );
  };

/** How a page reads titles in one order, and the cursor that resumes after a title. */
interface SortPlan {
  readonly reader: (ctx: ReadCtx, scope: TitleScope) => Reader;
  readonly cursorAfter: (title: Doc<"titles">) => string;
}

const SORT_PLANS = {
  name: { reader: nameReader, cursorAfter: (title) => cursorOf(title, title.sortKey) },
  added: { reader: addedReader, cursorAfter: (title) => cursorOf(title, String(title.addedAt)) },
  year: {
    reader: yearReader,
    cursorAfter: (title) => cursorOf(title, title.year === null ? "" : String(title.year)),
  },
} as const satisfies { readonly [Sort in TitleSort]: SortPlan };

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
