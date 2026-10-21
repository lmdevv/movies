/**
 * Reads the retained log for a query: the last `limit` matching records, newest file first so a
 * recent question never reads the whole history, then, when following, each new matching line as
 * it is written. Files outside the query's time window are skipped by their names and modification
 * times; a modification time counts as up to two seconds early, since network shares and FAT keep
 * it that coarsely. Each line is redacted again before it is decoded or matched, so a file written by anything
 * else never shows, and a `grep` never finds, what the console would hide.
 */
import type { LogQuery, LogRecord } from "@movies/contracts/diagnostics";
import { Effect, FileSystem, Option, Path, Stream } from "effect";

import { redactJsonText } from "../observability.ts";
import { isNotFound } from "../platform/file-info.ts";
import type { LogFile } from "./log-files.ts";
import { decodeRecord, matchesFields, matchesText, mayMatch } from "./log-query.ts";
import * as RetainedLogs from "./retained-logs.ts";

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
  /** Since when the log could not be written or read; none while it works. */
  readonly unavailableSince: Option.Option<number>;
}

/** How much earlier than its last record a file's modification time may read. */
const MODIFIED_AT_SLACK_MS = 2000;

const overlaps = (file: LogFile, query: LogQuery): boolean =>
  (query.since === undefined || file.modifiedAt + MODIFIED_AT_SLACK_MS >= query.since) &&
  (query.until === undefined || file.startsAt < query.until);

/**
 * The match on `line`, if it is one. Filters that redaction cannot change run on the line as
 * written, so most lines are decoded once and never redacted; `grep` and the record handed on
 * see the redacted line.
 */
const matchLine = (query: LogQuery, line: string): Option.Option<Match> => {
  if (
    !mayMatch(query, line) ||
    !Option.exists(decodeRecord(line), (raw) => matchesFields(query, raw, line))
  ) {
    return Option.none();
  }

  const redacted = redactJsonText(line);

  return decodeRecord(redacted).pipe(
    Option.filter(
      (record) => matchesText(query, redacted) && matchesFields(query, record, redacted),
    ),
    Option.map((record) => ({ line: redacted, record })),
  );
};

/** What a file that retention deleted after the snapshot holds. */
const nothingFound = () => ({ kept: Array.of<Match>(), total: 0 });

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
      Effect.catchIf(isNotFound, () => Effect.sync(nothingFound)),
      Effect.catch((error) =>
        Effect.logWarning("LogReader.unreadable").pipe(
          Effect.annotateLogs({ file: file.name, error: error.message }),
          Effect.map(nothingFound),
        ),
      ),
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
    unavailableSince: snapshot.unavailableSince,
  };

  return found;
});
