/** Library folder rules shared by admins adding libraries and migrations importing them. */
import type { Id } from "../_generated/dataModel";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/**
 * Normalizes and checks library folders: trimmed, absolute, without `.` or `..` segments, without
 * a trailing slash, and not a folder of another library (other than `except`).
 */
export const checkRoots = async (
  ctx: ReadCtx,
  roots: ReadonlyArray<string>,
  except: Id<"libraries"> | null,
): Promise<Array<string>> => {
  const normalized = [...new Set(roots.map((root) => root.trim().replace(/\/+$/u, "") || "/"))];

  if (normalized.length === 0) return fail("invalid_args", "Add at least one folder");

  const invalid = normalized.find((root) => {
    const segments = root.split("/");

    return !root.startsWith("/") || segments.includes("..") || segments.includes(".");
  });

  if (invalid !== undefined)
    return fail("invalid_args", `Folders must be absolute paths: ${invalid}`);

  const others = await ctx.db.query("libraries").collect();

  const taken = others
    .filter((other) => other._id !== except)
    .flatMap((other) => other.roots)
    .find((root) => normalized.includes(root));

  if (taken !== undefined) return fail("conflict", `Another library already uses ${taken}`);

  return normalized;
};
