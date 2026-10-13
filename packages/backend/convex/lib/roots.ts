/** Library folder rules shared by admins adding libraries and migrations importing them. */
import type { Id } from "../_generated/dataModel";
import { LIBRARY_ROOT_MAX, LIBRARY_ROOTS_MAX } from "./bounds";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** A folder trimmed, with repeated and trailing slashes removed (`/` stays `/`). */
export const normalizeRoot = (root: string): string =>
  root
    .trim()
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "") || "/";

/** Whether `path` is `root` or lies inside it; both normalized. */
export const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? root : `${root}/`);

/**
 * Normalizes and checks library folders: absolute, at most 1024 characters, without `.` or `..`
 * segments, and neither the same as, inside, nor containing a folder of another library (other
 * than `except`). Nested libraries would let a grant on one expose the other's files.
 */
export const checkRoots = async (
  ctx: ReadCtx,
  roots: ReadonlyArray<string>,
  except: Id<"libraries"> | null,
): Promise<Array<string>> => {
  const normalized = [...new Set(roots.map(normalizeRoot))];

  if (normalized.length === 0) return fail("invalid_args", "Add at least one folder");

  if (normalized.length > LIBRARY_ROOTS_MAX) {
    return fail("invalid_args", `A library has at most ${LIBRARY_ROOTS_MAX} folders`);
  }

  const invalid = normalized.find((root) => {
    const segments = root.split("/");

    return !root.startsWith("/") || segments.includes("..") || segments.includes(".");
  });

  if (invalid !== undefined)
    return fail("invalid_args", `Folders must be absolute paths: ${invalid}`);

  const long = normalized.find((root) => root.length > LIBRARY_ROOT_MAX);

  if (long !== undefined) {
    return fail("invalid_args", `Folders have at most ${LIBRARY_ROOT_MAX} characters`);
  }

  const others = (await ctx.db.query("libraries").collect()).filter(
    (other) => other._id !== except,
  );

  const taken = others.flatMap((other) => other.roots).find((root) => normalized.includes(root));

  if (taken !== undefined) return fail("conflict", `Another library already uses ${taken}`);

  for (const other of others) {
    for (const known of other.roots.map(normalizeRoot)) {
      const overlap = normalized.find((root) => isInside(root, known) || isInside(known, root));

      if (overlap !== undefined) {
        return fail(
          "invalid_args",
          isInside(overlap, known)
            ? `${overlap} is inside ${known}, a folder of the library "${other.name}"`
            : `${overlap} contains ${known}, a folder of the library "${other.name}"`,
        );
      }
    }
  }

  return normalized;
};
