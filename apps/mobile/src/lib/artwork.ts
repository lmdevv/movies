import { artworkUrl as mediaArtworkUrl } from "@movies/contracts/artwork";
import type { ArtworkWidth } from "@movies/contracts/artwork";

const WIDTHS = {
  thumb: 185,
  poster: 342,
  card: 780,
  backdrop: 1280,
} as const satisfies Record<string, ArtworkWidth>;

/** Where an image is drawn, which decides the width it is fetched at. */
export type ArtworkUse = keyof typeof WIDTHS;

/** The image URL for an artwork key, or undefined without one so the slot draws its placeholder. */
export const artworkUrl = (
  mediaUrl: string,
  key: string | null | undefined,
  use: ArtworkUse,
): string | undefined =>
  key === null || key === undefined || key === ""
    ? undefined
    : mediaArtworkUrl(mediaUrl, key, WIDTHS[use]);
