/** Shapes shared by many commands: pagination, empty arguments, and acknowledgements. */
import { Schema } from "effect";

/** Arguments of a command that takes none. */
export const NoArgs = Schema.Struct({});

/** The result of a command that only reports success. */
export const Ok = Schema.Struct({ ok: Schema.Literal(true) });

/** A short human-entered name, trimmed, 1 to 80 characters. */
export const DisplayName = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(80));

/** An opaque continuation cursor from a previous page. */
export const Cursor = Schema.String;

/** Paging arguments: an optional cursor from the previous page and a page size from 1 to 100. */
export const PageArgs = {
  cursor: Schema.optionalKey(Schema.NullOr(Cursor)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};

/**
 * A page of `item`. `nextCursor` is null on the last page. A page may hold fewer items than asked
 * for, even none, when filtering hides records; keep reading until `nextCursor` is null.
 */
export const Page = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Cursor) });
