import { createKeymap } from "@movies/ui/lib/keymap";
import type { KeymapEntry } from "@movies/ui/lib/keymap";
import { detectPlatform } from "@movies/ui/lib/use-keymap";

/**
 * Every global keyboard shortcut, listed once. The command menu draws keycaps from here, so a
 * shortcut changes in one place.
 */
const SHORTCUTS = [
  { id: "menu.toggle", keys: "mod+k", whileTyping: true, title: "Search or jump to…" },
  { id: "search.open", keys: "/", title: "Search" },
  { id: "profile.switch", keys: "mod+shift+p", whileTyping: true, title: "Switch profile" },
  { id: "go.home", keys: "g h", title: "Home" },
  { id: "go.movies", keys: "g m", title: "Movies" },
  { id: "go.shows", keys: "g s", title: "Shows" },
  { id: "go.my-list", keys: "g l", title: "My List" },
  { id: "go.settings", keys: "g ,", title: "Settings" },
  { id: "rows.next", keys: "j", title: "Next row" },
  { id: "rows.previous", keys: "k", title: "Previous row" },
] as const satisfies ReadonlyArray<KeymapEntry<string> & { readonly title: string }>;

/** The id of a global shortcut. */
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const platform = detectPlatform();

/** The global shortcut registry resolved for this browser's keyboard. */
export const keymap = createKeymap<ShortcutId>(SHORTCUTS, platform);

/** A shortcut written as one label, such as `⌘K` on Apple devices or `Ctrl K` elsewhere. */
export const shortcutLabel = (id: ShortcutId): string =>
  keymap.keycaps(id).join(platform === "mac" ? "" : " ");
