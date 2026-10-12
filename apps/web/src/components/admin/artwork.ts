import { MEDIA_URL } from "@/movies-sdk";

/** The URL of an artwork key; the media service resolves keys under `/artwork/`. */
export const artworkUrl = (key: string): string =>
  `${MEDIA_URL.replace(/\/+$/u, "")}/artwork/${encodeURIComponent(key)}`;
