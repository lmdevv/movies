/**
 * The retained log folder as data: file names, when the writer starts a new file, and which files
 * retention deletes. Every decision here is a pure function of the listing, so running it again
 * after a crash, or twice in a row, reaches the same folder.
 *
 * A file is named after a time no record in it is earlier than, `media-20261021T140503123Z.ndjson`
 * (with `-1`, `-2`, … before `.ndjson` when several share it), so names sort by age and a file
 * holds records from its name's time to its modification time. A reader may skip a file by its
 * name alone. Files that do not match the pattern are never touched.
 */
import { Option } from "effect";

/** Where a file stands among the others, from its name. */
interface FileOrder {
  /** No record in the file is earlier than this. */
  readonly startsAt: number;
  /** Which of the files sharing `startsAt` it is, from 0. */
  readonly sequence: number;
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

const NAME = /^media-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-([1-9]\d*))?\.ndjson$/u;

/** The name of the `sequence`th file whose records start at `startsAt`. */
export const fileName = (startsAt: number, sequence = 0): string =>
  `media-${new Date(startsAt).toISOString().replaceAll(/[-:.]/gu, "")}${sequence === 0 ? "" : `-${String(sequence)}`}.ndjson`;

/** Where the file named `name` stands; none for a name the writer never makes. */
export const orderOf = (name: string): Option.Option<FileOrder> => {
  const match = NAME.exec(name);

  if (match === null) return Option.none();
  const [, year, month, day, hours, minutes, seconds, millis] = match.slice(0, 8).map(Number);
  const time = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hours, minutes, seconds, millis);

  return Number.isNaN(time)
    ? Option.none()
    : Option.some({ startsAt: time, sequence: Number(match[8] ?? 0) });
};

/** Oldest first. */
export const byAge = (left: FileOrder, right: FileOrder): number =>
  left.startsAt - right.startsAt || left.sequence - right.sequence;

/**
 * The most one file holds: an eighth of the total, at most 64 MiB, so the size cap always fits
 * several files and retention deletes in steps that keep most of the history.
 */
export const fileCapBytes = (maxBytes: number): number =>
  Math.min(64 * MEBIBYTE, Math.floor(maxBytes / 8));

const utcDay = (time: number): number => Math.floor(time / 86_400_000);

/**
 * Whether the next `incomingBytes` go to a new file: they would grow the current one past
 * `capBytes`, or it is from an earlier day.
 */
export const shouldRotate = (
  current: { readonly startsAt: number; readonly sizeBytes: number },
  now: number,
  capBytes: number,
  incomingBytes: number,
): boolean =>
  current.sizeBytes + incomingBytes > capBytes || utcDay(current.startsAt) !== utcDay(now);

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
