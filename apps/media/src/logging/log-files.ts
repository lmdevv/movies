/**
 * The retained log folder as data: file names, when the writer starts a new file, and which files
 * retention deletes. Every decision here is a pure function of the listing, so running it again
 * after a crash, or twice in a row, reaches the same folder.
 *
 * A file is named after its place in the log and a time none of its records is earlier than,
 * `media-000000000042-20261021T140503123Z.ndjson`. The place is a sequence number the writer never
 * reuses, so names list in the order the files were written, and reading and retention follow it
 * whatever the clock did. The time lets a reader skip a file by its name alone: the file holds
 * records from that time up to its modification time. Files that match neither this pattern nor
 * the earlier one (`legacyOrderOf`) are never touched.
 */
import { Option } from "effect";

/** Where a file stands among the others, from its name. */
interface FileOrder {
  /** Its place in the log: a later file has a larger one. */
  readonly sequence: number;
  /** No record in the file is earlier than this. */
  readonly startsAt: number;
}

/** One retained log file. */
export interface LogFile extends FileOrder {
  readonly name: string;
  readonly sizeBytes: number;
  /** When its last record was written. */
  readonly modifiedAt: number;
}

/** Retention limits. */
export interface Retention {
  /** Files last written longer ago than this many milliseconds go. */
  readonly maxAgeMs: number;
  /**
   * All files together never grow past this: the oldest go before a write would pass it. At least
   * `MIN_LOG_BYTES`.
   */
  readonly maxBytes: number;
}

const MEBIBYTE = 1024 * 1024;

/** The smallest size cap: eight files of 1 MiB. */
export const MIN_LOG_BYTES = 8 * MEBIBYTE;

const SEQUENCE_DIGITS = 12;

const NAME = /^media-(\d{12,})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.ndjson$/u;

/** Names written before files carried a sequence: a start time, then `-1`, `-2`, … on a tie. */
const LEGACY_NAME =
  /^media-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-([1-9]\d*))?\.ndjson$/u;

const compactTime = (time: number): string =>
  new Date(time).toISOString().replaceAll(/[-:.]/gu, "");

/** The time `parts` (year, month, day, hours, minutes, seconds, milliseconds) name; none if invalid. */
const timeOf = (parts: ReadonlyArray<string | undefined>): Option.Option<number> => {
  const [year, month, day, hours, minutes, seconds, millis] = parts.map(Number);
  const time = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hours, minutes, seconds, millis);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

/** The name of the file at `sequence` whose records start at `startsAt`. */
export const fileName = (sequence: number, startsAt: number): string =>
  `media-${String(sequence).padStart(SEQUENCE_DIGITS, "0")}-${compactTime(startsAt)}.ndjson`;

/** Where the file named `name` stands; none for a name the writer never makes. */
export const orderOf = (name: string): Option.Option<FileOrder> => {
  const match = NAME.exec(name);

  if (match === null) return Option.none();

  return Option.map(timeOf(match.slice(2, 9)), (startsAt) => ({
    sequence: Number(match[1]),
    startsAt,
  }));
};

/** A file under the earlier naming, in the order that naming gave it. */
interface LegacyFile {
  readonly name: string;
  readonly startsAt: number;
  readonly tie: number;
}

/**
 * The renames that give files under the earlier naming a place after every current file, in the
 * order the earlier naming listed them: by start time, then by suffix.
 */
export const planMigration = (
  names: ReadonlyArray<string>,
): ReadonlyArray<readonly [from: string, to: string]> => {
  const next = Math.max(
    0,
    ...names.flatMap((name) => Option.toArray(orderOf(name)).map((order) => order.sequence + 1)),
  );

  const legacy = names
    .flatMap((name): ReadonlyArray<LegacyFile> => {
      const match = LEGACY_NAME.exec(name);

      if (match === null) return [];

      return Option.toArray(timeOf(match.slice(1, 8))).map((startsAt) => ({
        name,
        startsAt,
        tie: Number(match[8] ?? 0),
      }));
    })
    .toSorted((left, right) => left.startsAt - right.startsAt || left.tie - right.tie);

  return legacy.map((file, index) => [file.name, fileName(next + index, file.startsAt)] as const);
};

/** The sequence a new file takes after `files`: one past the largest. */
export const nextSequence = (files: ReadonlyArray<FileOrder>): number =>
  Math.max(0, ...files.map((file) => file.sequence + 1));

/** Oldest first. */
export const byAge = (left: FileOrder, right: FileOrder): number => left.sequence - right.sequence;

/**
 * The most one file holds: an eighth of the total, at most 64 MiB, so the size cap always fits
 * several files and retention deletes in steps that keep most of the history.
 */
export const fileCapBytes = (maxBytes: number): number =>
  Math.min(64 * MEBIBYTE, Math.floor(maxBytes / 8));

const utcDay = (time: number): number => Math.floor(time / 86_400_000);

/**
 * Whether records from `firstAt` on, `incomingBytes` of them, go to a new file: they would grow
 * the current one past `capBytes`, they are from a later day, or the clock stepped back to before
 * the current file began, which its name promises no record is.
 */
export const shouldRotate = (
  current: { readonly startsAt: number; readonly sizeBytes: number },
  firstAt: number,
  capBytes: number,
  incomingBytes: number,
): boolean =>
  current.sizeBytes + incomingBytes > capBytes ||
  firstAt < current.startsAt ||
  utcDay(current.startsAt) !== utcDay(firstAt);

/**
 * The files retention deletes, oldest first: those older than `maxAgeMs`, then the oldest of the
 * rest while they and `reserveBytes` about to be written are larger than `maxBytes`. The file being
 * written, `active`, always stays.
 */
export const planPrune = (
  files: ReadonlyArray<LogFile>,
  retention: Retention,
  now: number,
  active: Option.Option<string>,
  reserveBytes = 0,
): ReadonlyArray<string> => {
  const candidates = files
    .filter((file) => Option.getOrUndefined(active) !== file.name)
    .toSorted(byAge);

  const expired = candidates.filter((file) => now - file.modifiedAt > retention.maxAgeMs);
  const expiredNames = new Set(expired.map((file) => file.name));
  const kept = files.filter((file) => !expiredNames.has(file.name));

  const oversize = candidates
    .filter((file) => !expiredNames.has(file.name))
    .reduce(
      (state, file) =>
        state.total + reserveBytes > retention.maxBytes
          ? { total: state.total - file.sizeBytes, names: [...state.names, file.name] }
          : state,
      {
        total: kept.reduce((sum, file) => sum + file.sizeBytes, 0),
        names: Array.of<string>(),
      },
    );

  return [...expired.map((file) => file.name), ...oversize.names];
};
