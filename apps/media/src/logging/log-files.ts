/**
 * The retained log folder as data: file names, when the writer starts a new file, and which files
 * retention deletes. Every decision here is a pure function of the listing, so running it again
 * after a crash, or twice in a row, reaches the same folder.
 *
 * A file is named after the instant it was created, `media-20261021T140503123Z.ndjson`, so names
 * sort by age and a file holds records from its creation to its modification time. Files that do
 * not match the pattern are never touched.
 */
import { Option } from "effect";

/** One retained log file. */
export interface LogFile {
  readonly name: string;
  /** When the writer created it, from its name. */
  readonly createdAt: number;
  readonly sizeBytes: number;
  /** When its last record was written. */
  readonly modifiedAt: number;
}

/** Retention limits. */
export interface Retention {
  /** Files last written longer ago than this many milliseconds go. */
  readonly maxAgeMs: number;
  /** The oldest files go while all of them together are larger than this. */
  readonly maxBytes: number;
}

const NAME = /^media-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.ndjson$/u;

const MEBIBYTE = 1024 * 1024;

/** The name of a file created at `createdAt`. */
export const fileName = (createdAt: number): string =>
  `media-${new Date(createdAt).toISOString().replaceAll(/[-:.]/gu, "")}.ndjson`;

/** When the file named `name` was created; none for a name the writer never makes. */
export const createdAtOf = (name: string): Option.Option<number> => {
  const match = NAME.exec(name);

  if (match === null) return Option.none();
  const [, year, month, day, hours, minutes, seconds, millis] = match.map(Number);
  const time = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hours, minutes, seconds, millis);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

/**
 * The size at which the writer starts another file: an eighth of the total, so retention deletes
 * in steps that keep most of the history, between 1 and 64 MiB.
 */
export const fileCapBytes = (maxBytes: number): number =>
  Math.min(64 * MEBIBYTE, Math.max(MEBIBYTE, Math.floor(maxBytes / 8)));

const utcDay = (time: number): number => Math.floor(time / 86_400_000);

/** Whether the next records go to a new file: the current one is full or from an earlier day. */
export const shouldRotate = (
  current: { readonly createdAt: number; readonly sizeBytes: number },
  now: number,
  capBytes: number,
): boolean => current.sizeBytes >= capBytes || utcDay(current.createdAt) !== utcDay(now);

/**
 * The files retention deletes, oldest first: those older than `maxAgeMs`, then the oldest of the
 * rest while the folder is larger than `maxBytes`. The file being written, `active`, always stays.
 */
export const planPrune = (
  files: ReadonlyArray<LogFile>,
  retention: Retention,
  now: number,
  active: Option.Option<string>,
): ReadonlyArray<string> => {
  const candidates = files
    .filter((file) => Option.getOrUndefined(active) !== file.name)
    .toSorted((left, right) => left.createdAt - right.createdAt);

  const expired = candidates.filter((file) => now - file.modifiedAt > retention.maxAgeMs);
  const expiredNames = new Set(expired.map((file) => file.name));
  const kept = files.filter((file) => !expiredNames.has(file.name));

  const oversize = candidates
    .filter((file) => !expiredNames.has(file.name))
    .reduce(
      (state, file) =>
        state.total > retention.maxBytes
          ? { total: state.total - file.sizeBytes, names: [...state.names, file.name] }
          : state,
      {
        total: kept.reduce((sum, file) => sum + file.sizeBytes, 0),
        names: Array.of<string>(),
      },
    );

  return [...expired.map((file) => file.name), ...oversize.names];
};
