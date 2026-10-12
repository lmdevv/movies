/** Letters in a device user code, such as `HD5R5GTL` without its dash. */
export const USER_CODE_LENGTH = 8;

/** The code's letters as typed into the boxes: upper-cased, without spaces or the dash. */
export const codeLetters = (typed: string): string =>
  typed
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .slice(0, USER_CODE_LENGTH);

/** The code as the server stores it, `HD5R-5GTL`, once all eight characters are in. */
export const formatUserCode = (letters: string): string | null =>
  letters.length === USER_CODE_LENGTH ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
