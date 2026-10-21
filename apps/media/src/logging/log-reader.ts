/**
 * Reads the retained log for a query: the last `limit` matching records, newest file first so a
 * recent question never reads the whole history, then, when following, each new matching line as
 * it is written. Files outside the query's time window are skipped by their names and modification
 * times. Lines are redacted again on the way out, so a file written by anything else still never
 * shows what the console would hide.
 */
import type { LogQuery, LogRecord } from "@movies/contracts/diagnostics";
import { Effect, FileSystem, Option, Path, Stream } from "effect";

import { redactJsonText } from "../observability.ts";
import type { LogFile } from "./log-files.ts";
import { decodeRecord, matches, mayMatch } from "./log-query.ts";
import * as RetainedLogs from "./retained-logs.ts";

/** The records a query asks for when it names no limit. */
const DEFAULT_LOG_LIMIT = 500;

/** One matching line and its record. */
export interface Match {
  readonly line: string;
  readonly record: LogRecord;
}

/** What a query found. */
interface Found {
  /** Matching records, oldest first. */
  readonly matches: ReadonlyArray<Match>;
  /** Older records may match too: `limit` was reached before the oldest file was read. */
  readonly truncated: boolean;
  /** Matching lines written after the query started; empty unless it follows. */
  readonly live: Stream.Stream<string>;
}

/** Whether `file` may hold records inside the query's time window. */
const overlaps = (file: LogFile, query: LogQuery): boolean =>
  (query.since === undefined || file.modifiedAt >= query.since) &&
  (query.until === undefined || file.createdAt < query.until);

/** The decoded record of `line` when it matches `query`. */
const matchLine = (query: LogQuery, line: string): Option.Option<Match> =>
  mayMatch(query, line)
    ? decodeRecord(line).pipe(
        Option.filter((record) => matches(query, record, line)),
        Option.map((record) => ({ line: redactJsonText(line), record })),
      )
    : Option.none();

/** Reads the retained log for `query`; following lasts as long as the scope. */
export const read = Effect.fn("LogReader.read")(function* (query: LogQuery) {
  const retained = yield* RetainedLogs.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limit = query.limit ?? DEFAULT_LOG_LIMIT;
  const snapshot = yield* retained.snapshot;
  const files = snapshot.files.filter((file) => overlaps(file, query)).toReversed();

  /** The last `limit` matches in `file`, and how many it holds, read no further than its size. */
  const lastMatches = (file: LogFile) =>
    fs.stream(path.join(snapshot.directory, file.name), { bytesToRead: file.sizeBytes }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => matchLine(query, line)),
      Stream.filter(Option.isSome),
      Stream.runFold(
        () => ({ kept: Array.of<Match>(), total: 0 }),
        (state, match) => {
          state.kept.push(match.value);

          if (state.kept.length > limit) state.kept.shift();

          return { kept: state.kept, total: state.total + 1 };
        },
      ),
      // Retention may delete a file between the snapshot and this read.
      Effect.orElseSucceed(() => ({ kept: Array.of<Match>(), total: 0 })),
    );

  const collected: Array<Match> = [];
  let total = 0;
  let index = 0;

  while (index < files.length && total < limit) {
    const file = files[index];

    if (file !== undefined) {
      const scanned = yield* lastMatches(file);

      collected.unshift(...scanned.kept);
      total += scanned.total;
    }

    index += 1;
  }

  const found: Found = {
    matches: collected.slice(-limit),
    truncated: total > limit || index < files.length,
    live:
      query.follow === true
        ? Stream.fromSubscription(snapshot.live).pipe(
            Stream.map((line) => matchLine(query, line)),
            Stream.filter(Option.isSome),
            Stream.map((match) => match.value.line),
          )
        : Stream.empty,
  };

  return found;
});
