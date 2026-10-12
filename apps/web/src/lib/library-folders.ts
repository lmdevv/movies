/**
 * Library folder checks the web app makes before saving, matching the server's rules (absolute,
 * no `.` or `..` segments, no trailing slash) so most mistakes show before a round trip. The
 * server still decides; its refusals (such as a folder another library uses) show the same way.
 */

/** The folder as the server stores it: trimmed, without trailing slashes. */
export const normalizeFolder = (path: string): string => {
  const trimmed = path.trim().replace(/\/+$/u, "");

  return trimmed === "" && path.trim() !== "" ? "/" : trimmed;
};

/** Why a typed folder cannot be saved, or null when it looks valid. */
export const folderProblem = (path: string): string | null => {
  const folder = normalizeFolder(path);

  if (folder === "") return "Enter the folder's path on the server.";

  if (!folder.startsWith("/")) return "Use the full path from the root, such as /mnt/nas/movies.";

  const segments = folder.split("/");

  if (segments.includes(".") || segments.includes("..")) {
    return "Write the path without . or .. parts.";
  }

  return null;
};
