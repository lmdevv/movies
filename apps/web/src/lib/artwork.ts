import { MEDIA_BASE_URL } from "@/env";

/**
 * The URL of an artwork key, which the media service resolves at `/artwork/<key>`; undefined when
 * a title has no such artwork, so cards draw their blank placeholder.
 */
export const artworkUrl = (key: string | null): string | undefined =>
  key === null || key === ""
    ? undefined
    : `${MEDIA_BASE_URL}/artwork/${key.split("/").map(encodeURIComponent).join("/")}`;
