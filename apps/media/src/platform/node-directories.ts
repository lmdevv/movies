/**
 * Node file system primitives Effect's `FileSystem` service does not expose: directory entries
 * with their types (so a scan can spot symbolic links without a system call per entry), free
 * space on a volume, and the kind of file system a folder lives on. This Effect-free leaf may
 * reject; its Effect callers translate rejections into typed errors.
 */
import { readdir, statfs } from "node:fs/promises";

/** What a directory entry is, without following symbolic links. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

/** One entry of a directory listing. */
export interface DirectoryEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/** Lists a directory with entry types. */
export const listEntries = async (path: string): Promise<ReadonlyArray<DirectoryEntry>> => {
  const entries = await readdir(path, { withFileTypes: true });

  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other",
  }));
};

/** Bytes available to unprivileged users on the volume holding `path`. */
export const freeBytes = async (path: string): Promise<number> => {
  const info = await statfs(path);

  return info.bavail * info.bsize;
};

/** The `statfs` magic number of the file system holding `path`, such as `0x6969` for NFS. */
export const fileSystemType = async (path: string): Promise<number> => (await statfs(path)).type;

/** The Node error code of a rejection, such as `ENOENT` or `EACCES`. */
export const errorCode = (cause: unknown): string =>
  cause instanceof Error && "code" in cause ? String(cause.code) : "UNKNOWN";
