/**
 * A write still costs a document write, and wakes every query that read the document, when it
 * bumps a timestamp but changes nothing else. Writers that rewrite whole records, such as a rescan,
 * check first.
 */
import { compareValues } from "convex/values";
import type { Value } from "convex/values";

/**
 * Whether any of `fields` differs from the same key of `doc`, compared as Convex compares values:
 * objects key by key, whatever their order. A key `fields` sets to undefined differs only from a
 * stored value.
 */
export const changesAny = (
  doc: Readonly<Record<string, Value | undefined>>,
  fields: Readonly<Record<string, Value | undefined>>,
): boolean =>
  Object.entries(fields).some(([key, value]) => {
    const stored = doc[key];

    return stored === undefined || value === undefined
      ? stored !== value
      : compareValues(stored, value) !== 0;
  });
