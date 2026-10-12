/** Marks the scrolling track of a media row; {@link moveRowFocus} walks these in page order. */
const MEDIA_ROW_ATTRIBUTE = "data-media-row";

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The focusable cards of a row track, in order. */
export function rowItems(track: Element): ReadonlyArray<HTMLElement> {
  return [...track.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Focus a card and bring it into view without jumping past it. */
export function focusRowItem(item: HTMLElement): void {
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
}

/**
 * Move keyboard focus to the next (`1`) or previous (`-1`) media row on the page, keeping the
 * column when the target row is long enough. With nothing focused in a row, `1` enters the first
 * row and `-1` the last.
 *
 * @returns Whether focus moved.
 */
export function moveRowFocus(direction: 1 | -1): boolean {
  const tracks = [...document.querySelectorAll(`[${MEDIA_ROW_ATTRIBUTE}]`)];
  const active = document.activeElement;
  const current = tracks.findIndex((track) => active !== null && track.contains(active));

  const target =
    tracks[current === -1 ? (direction === 1 ? 0 : tracks.length - 1) : current + direction];

  if (target === undefined) return false;

  const column =
    current === -1
      ? 0
      : Math.max(
          0,
          rowItems(tracks[current] ?? target).findIndex((item) => item === active),
        );

  const items = rowItems(target);
  const item = items[Math.min(column, items.length - 1)];

  if (item === undefined) return false;

  focusRowItem(item);
  item.closest("section")?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });

  return true;
}
