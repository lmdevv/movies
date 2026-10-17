/**
 * The avatar set profiles choose from, shared with the web app (`apps/web/src/lib/avatars.ts`). A
 * profile stores the key; each client draws its art. Here each key is a two-stop gradient tile
 * from the `--color-avatar-*` tokens. Unknown keys (from a newer client) draw the plain tile.
 */

/** Avatar keys in picker order. `red` is the backend's default for a new account's profile. */
export const AVATAR_KEYS = ["red", "blue", "green", "plum", "teal", "slate", "kids"] as const;

/** An avatar this app draws. */
export type AvatarKey = (typeof AVATAR_KEYS)[number];

const known: ReadonlySet<string> = new Set(AVATAR_KEYS);

const isAvatarKey = (key: string): key is AvatarKey => known.has(key);

/** The gradient's stops as theme variables, top left to bottom right. */
type AvatarGradient = ReadonlyArray<`--color-${string}`>;

/** How an avatar key draws. */
export interface AvatarArt {
  /** The gradient behind the tile, or null for the plain raised tile of an unknown key. */
  readonly gradient: AvatarGradient | null;
  /** What sits on the tile: the name's initial, the art's own `kids` lettering, or the TV glyph. */
  readonly mark: "monogram" | "lettering" | "kidsGlyph";
}

const gradientFor = (key: AvatarKey): AvatarGradient =>
  key === "kids"
    ? ["--color-avatar-kids-from", "--color-avatar-kids-via", "--color-avatar-kids-to"]
    : [`--color-avatar-${key}-from`, `--color-avatar-${key}-to`];

/**
 * How `profile`'s avatar draws. The `kids` art carries its own lettering; an unknown key on a kids
 * profile shows the TV glyph Paper draws for kids tiles.
 */
export const avatarArt = (profile: {
  readonly avatar: string;
  readonly kids: boolean;
}): AvatarArt => {
  const { avatar, kids } = profile;

  if (!isAvatarKey(avatar)) return { gradient: null, mark: kids ? "kidsGlyph" : "monogram" };

  return { gradient: gradientFor(avatar), mark: avatar === "kids" ? "lettering" : "monogram" };
};

/**
 * The letter on a monogram tile: the name's first character, uppercased. Characters outside the
 * Basic Multilingual Plane, such as emoji, stay whole rather than splitting into half a pair.
 */
export const monogram = (name: string): string => {
  const first = name.trim().codePointAt(0);

  return first === undefined ? "" : String.fromCodePoint(first).toUpperCase();
};

/** The first avatar no other profile uses, leaving the kids art to kids profiles. */
export const firstFreeAvatar = (taken: ReadonlyArray<string>): AvatarKey =>
  AVATAR_KEYS.find((key) => key !== "kids" && !taken.includes(key)) ?? "red";

/** What VoiceOver reads for an avatar key, such as `Blue` or `Kids`. */
export const avatarLabel = (key: string): string =>
  key === "" ? "Avatar" : `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
