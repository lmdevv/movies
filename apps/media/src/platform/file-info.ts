/** Reading Effect `FileSystem` stat results the way every cache key and validator here does. */
import { type FileSystem, Option } from "effect";

/**
 * A file's modification time in milliseconds since the epoch, or 0 when the platform reports
 * none. Cache keys, ETags, and change checks compare it as a plain number.
 */
export const modifiedAtMs = (info: FileSystem.File.Info): number =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
