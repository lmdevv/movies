/** Artwork from the connected media service, resized for where the phone draws it. */
import { artworkUrl } from "@movies/contracts/artwork";
import type { ArtworkWidth } from "@movies/contracts/artwork";
import { useCallback } from "react";

import { useDevice } from "@/device/device-state";

/**
 * The width the media service resizes artwork to for each use, enough for 3x screens: poster
 * cards (110pt), landscape and collection cards (228–280pt), and full-bleed backdrops.
 */
const WIDTHS = {
  poster: 342,
  card: 780,
  backdrop: 1280,
} as const satisfies Readonly<Record<string, ArtworkWidth>>;

/** Where an image is drawn, which decides the width it is fetched at. */
type ArtworkUse = keyof typeof WIDTHS;

/** The URL of an artwork key for `use`; undefined without a key, so cards draw their placeholder. */
type ArtworkResolver = (key: string | null, use: ArtworkUse) => string | undefined;

/** Resolves artwork keys against the connected server. */
export const useArtwork = (): ArtworkResolver => {
  const { server } = useDevice();
  const mediaUrl = server?.mediaUrl ?? null;

  return useCallback(
    (key, use) =>
      key === null || key === "" || mediaUrl === null
        ? undefined
        : artworkUrl(mediaUrl, key, WIDTHS[use]),
    [mediaUrl],
  );
};
