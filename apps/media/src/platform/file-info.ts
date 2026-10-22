import { type FileSystem, Option, type PlatformError, Predicate } from "effect";

/**
 * A file's modification time in milliseconds since the epoch, or 0 when the platform reports
 * none. Cache keys, ETags, and change checks compare it as a plain number.
 */
export const modifiedAtMs = (info: FileSystem.File.Info): number =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

/** Whether `error` is a file system failure for a path that does not exist: a miss, not a fault. */
export const isNotFound = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, "NotFound");
