/**
 * WebCrypto helpers. The Convex runtime implements `crypto.subtle` in queries, mutations, and
 * actions (see docs/spikes.md). Secrets that must be unpredictable are generated in actions, which
 * get real randomness; queries and mutations use seeded randomness only for salts.
 */
const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Base64url without padding. */
export const base64UrlEncode = (bytes: Uint8Array): string => {
  const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

/** Decodes base64url (padding optional), or returns null when it is not base64url. */
export const base64UrlDecode = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[\w-]*={0,2}$/u.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));

  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
};

/** SHA-256 of a string, lowercase hex. Used to store API keys, invite codes, and device codes. */
export const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/** `byteCount` random bytes as base64url. Call from an action for secrets. */
export const randomSecret = (byteCount: number): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteCount)));

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/**
 * A device sign-in code people type: eight consonants as `XXXX-XXXX`, about 34 bits. The alphabet
 * has no vowels or look-alike digits, so codes never spell words and survive reading aloud.
 */
export const randomUserCode = (): string => {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length),
  ).join("");

  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

/** Normalizes a typed device code: uppercase, without spaces, with the dash restored. */
export const normalizeUserCode = (typed: string): string => {
  const letters = typed.toUpperCase().replaceAll(/[^A-Z]/gu, "");

  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
};

const PIN_ITERATIONS = 100_000;

/** PBKDF2-SHA256 of a PIN with a salt, base64url. */
export const hashPin = async (pin: string, salt: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PIN_ITERATIONS },
    key,
    256,
  );

  return base64UrlEncode(new Uint8Array(bits));
};

/** Compares two strings in time that depends only on their lengths. */
export const constantTimeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
};
