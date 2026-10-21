/**
 * What a log query matches. A record matches when every filter the query gives does: its time
 * within `since` and `until`, its level at least `level`, its `sessionId` and `streamId`
 * annotations equal to the query's, its `elapsedMs` annotation (timed requests and segment loads)
 * at least `slowMs`, and its JSON line containing `grep`, ignoring case.
 */
import { atLeast, type LogQuery, LogRecord } from "@movies/contracts/diagnostics";
import { Option, Predicate, Schema } from "effect";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

/** The record on one log line; none for a line cut short by a crash or not written by the logger. */
export const decodeRecord = (line: string): Option.Option<LogRecord> => decodeLine(line);

/** When the record was logged, in milliseconds since the epoch; none for an unreadable time. */
const recordTime = (record: LogRecord): Option.Option<number> => {
  const time = Date.parse(record.timestamp);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

/**
 * Whether `line` may match, judged from its text alone: cheap enough to run on every line before
 * decoding any, and never false for a line that `matches`.
 */
export const mayMatch = (query: LogQuery, line: string): boolean =>
  (query.sessionId === undefined || line.includes(query.sessionId)) &&
  (query.streamId === undefined || line.includes(query.streamId)) &&
  (query.grep === undefined || line.toLowerCase().includes(query.grep.toLowerCase()));

/** Whether `record`, read from `line`, matches every filter of `query`. */
export const matches = (query: LogQuery, record: LogRecord, line: string): boolean => {
  const { since, until, level, sessionId, streamId, slowMs } = query;
  const time = recordTime(record);
  const { annotations } = record;
  const elapsedMs = annotations["elapsedMs"];

  return (
    mayMatch(query, line) &&
    (since === undefined || Option.exists(time, (at) => at >= since)) &&
    (until === undefined || Option.exists(time, (at) => at < until)) &&
    (level === undefined || atLeast(record.level, level)) &&
    (sessionId === undefined || annotations["sessionId"] === sessionId) &&
    (streamId === undefined || annotations["streamId"] === streamId) &&
    (slowMs === undefined || (Predicate.isNumber(elapsedMs) && elapsedMs >= slowMs))
  );
};
