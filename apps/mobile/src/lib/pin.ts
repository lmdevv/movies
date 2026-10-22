/** Digits in a PIN set or entered from this app. */
export const PIN_LENGTH = 4;

/** A keypad key: a digit or delete. */
export type PinKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "delete";

/** The keypad's rows as Paper lays them out; null is the empty slot left of 0. */
export const KEYPAD_ROWS: ReadonlyArray<ReadonlyArray<PinKey | null>> = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  [null, "0", "delete"],
];

/** The PIN after pressing `key`: a digit adds one until the PIN is full, delete removes one. */
export const pressKey = (pin: string, key: PinKey): string => {
  if (key === "delete") return pin.slice(0, -1);

  return pin.length >= PIN_LENGTH ? pin : `${pin}${key}`;
};

const MINUTE_MS = 60_000;

/** B07's line: `Try again in 2 minutes.`, rounding up, or `Try again now.` once the wait is over. */
export const lockoutLine = (retryAt: number, now: number): string => {
  const minutes = Math.ceil((retryAt - now) / MINUTE_MS);

  if (minutes <= 0) return "Try again now.";

  return minutes === 1 ? "Try again in 1 minute." : `Try again in ${minutes} minutes.`;
};

/** B06's line after a wrong PIN, with the tries left once few remain. */
export const wrongPinLine = (attemptsLeft: number): string => {
  if (attemptsLeft > 2) return "Incorrect PIN. Try again.";

  return attemptsLeft === 1
    ? "Incorrect PIN. 1 try left."
    : `Incorrect PIN. ${attemptsLeft} tries left.`;
};
