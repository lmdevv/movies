/**
 * Device sign-in on the phone (A05 Sign In with a Code): the server's user code split into the
 * boxes Paper draws, and the countdown under them.
 */

/**
 * The code's characters in groups, one box each. Codes such as `BCDF-GHJK` split at their
 * dashes; a code without one stays a single group.
 */
export const codeGroups = (userCode: string): ReadonlyArray<ReadonlyArray<string>> =>
  userCode
    .trim()
    .toUpperCase()
    .split("-")
    .filter((group) => group !== "")
    .map((group) => group.split(""));

/** What VoiceOver reads for a code: its characters one by one, such as `B C D F, G H J K`. */
export const spokenCode = (userCode: string): string =>
  codeGroups(userCode)
    .map((group) => group.join(" "))
    .join(", ");

const SECOND_MS = 1000;

/** `Expires in 4:52`, counting down to `Expires in 0:00`. */
export const expiresInLine = (expiresAt: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / SECOND_MS));
  const minutes = Math.floor(seconds / 60);

  return `Expires in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The approval page as people read it, such as `cinema.home/device`: no scheme, no query. */
export const approvalAddress = (verificationUrl: string): string =>
  verificationUrl.replace(/^https?:\/\//u, "").replace(/[?#].*$/u, "");
