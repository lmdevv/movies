/**
 * How a scan job that could not read its library's folders says so. The media service's scanner
 * starts its failure messages with these prefixes, and the apps read them back to show a NAS gone
 * offline or a folder the server may not use, so the wording lives here once.
 */

/** The start of each folder failure's message, by what went wrong. */
export const SCAN_FAILURE_PREFIXES = {
  /** The folder is outside the media service's approved `LIBRARY_ROOTS`. */
  rootNotApproved: "Library root not approved",
  /** The library's folder is missing, empty, or cannot be read, such as an unmounted share. */
  rootUnavailable: "Library root unavailable",
  /** A folder inside the library cannot be read. */
  folderUnreadable: "Library folder unreadable",
} as const;

/** Why a scan could not use its folders: they could not be reached, or the server refused them. */
export type FolderTrouble = "offline" | "notApproved";

/** The folder trouble a failed scan's `error` describes, or null for any other failure. */
export const folderTroubleOf = (error: string | null): FolderTrouble | null => {
  if (error === null) return null;

  if (error.startsWith(SCAN_FAILURE_PREFIXES.rootNotApproved)) return "notApproved";

  return error.startsWith(SCAN_FAILURE_PREFIXES.rootUnavailable) ||
    error.startsWith(SCAN_FAILURE_PREFIXES.folderUnreadable)
    ? "offline"
    : null;
};
