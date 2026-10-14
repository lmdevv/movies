/**
 * The one way a library folder is written down, shared by the web app (before saving) and Convex
 * (when storing and comparing roots), so the two can't drift apart.
 */

/**
 * `path` trimmed, with repeated slashes collapsed and any trailing run of slashes and whitespace
 * dropped (`/` itself stays). One pass, and normalizing the result changes nothing. A folder whose
 * real name ends in whitespace can't be named; trailing spaces before a slash are far more often
 * a typo than a name.
 */
export const normalizeFolder = (path: string): string =>
  path
    .trim()
    .replace(/\/{2,}/gu, "/")
    .replace(/(?<=.)[\s/]+$/u, "");
