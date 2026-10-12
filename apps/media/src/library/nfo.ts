/**
 * Reads Kodi/Jellyfin-style NFO files: `movie.nfo` or `<file>.nfo` for movies, `tvshow.nfo` for
 * shows, and `<episode file>.nfo` for episodes. Local NFO values win over metadata providers.
 */
import { Schema } from "effect";

import { childrenNamed, childText, parseXml, type XmlElement } from "./xml.ts";

/** Provider IDs found in local metadata. */
export const ExternalIds = Schema.Struct({
  tmdb: Schema.optional(Schema.String),
  imdb: Schema.optional(Schema.String),
  tvdb: Schema.optional(Schema.String),
});

/** Provider IDs found in local metadata. */
export interface ExternalIds extends Schema.Schema.Type<typeof ExternalIds> {}

/** Metadata read from an NFO file. Every field is optional; absent means "not stated locally". */
export const LocalMetadata = Schema.Struct({
  kind: Schema.Literals(["movie", "show", "episode"]),
  title: Schema.optional(Schema.String),
  originalTitle: Schema.optional(Schema.String),
  sortTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  /** First release or air date, `YYYY-MM-DD`. */
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  /** Certification such as `PG-13` or `TV-MA`, from `<mpaa>` or `<certification>`. */
  contentRating: Schema.optional(Schema.String),
  /** Community rating on a 0–10 scale. */
  rating: Schema.optional(Schema.Finite),
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  ids: ExternalIds,
  season: Schema.optional(Schema.Int),
  episode: Schema.optional(Schema.Int),
});

/** Metadata read from an NFO file. */
export interface LocalMetadata extends Schema.Schema.Type<typeof LocalMetadata> {}

/** Which NFO a caller expects; it also types URL-only NFO files. */
export type NfoKind = LocalMetadata["kind"];

const ROOTS: ReadonlyMap<string, NfoKind> = new Map([
  ["movie", "movie"],
  ["tvshow", "show"],
  ["episodedetails", "episode"],
]);

const IMDB_ID = /\b(tt\d{7,})\b/;

const TMDB_URL = /themoviedb\.org\/(?:movie|tv)\/(\d+)/;

const TVDB_URL = /thetvdb\.com\/.*?(?:id=|series\/)(\d+)/;

const integer = (text: string | undefined): number | undefined => {
  const value = text === undefined ? Number.NaN : Number.parseInt(text, 10);

  return Number.isFinite(value) ? value : undefined;
};

const decimal = (text: string | undefined): number | undefined => {
  const value = text === undefined ? Number.NaN : Number.parseFloat(text.replace(",", "."));

  return Number.isFinite(value) ? value : undefined;
};

const isoDate = (text: string | undefined): string | undefined =>
  text !== undefined && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;

const texts = (element: XmlElement, name: string): ReadonlyArray<string> =>
  childrenNamed(element, name)
    .flatMap((child) => child.text.split(" / "))
    .map((text) => text.trim())
    .filter((text) => text !== "");

const ratingOf = (element: XmlElement): number | undefined => {
  const ratings = childrenNamed(element, "ratings").flatMap((group) =>
    childrenNamed(group, "rating"),
  );

  const chosen =
    ratings.find((rating) => rating.attributes.get("default") === "true") ?? ratings[0];

  if (chosen !== undefined) {
    const value = decimal(childText(chosen, "value"));
    const max = decimal(chosen.attributes.get("max")) ?? 10;

    if (value !== undefined && max > 0) return Math.round((value / max) * 100) / 10;
  }

  return decimal(childText(element, "rating"));
};

const idsOf = (element: XmlElement): ExternalIds => {
  const unique = new Map<string, string>();

  for (const id of childrenNamed(element, "uniqueid")) {
    const type = id.attributes.get("type")?.toLowerCase();
    const value = id.text.trim();

    if (type !== undefined && value !== "" && !unique.has(type)) unique.set(type, value);
  }

  const legacyId = childText(element, "id");

  return {
    tmdb: unique.get("tmdb") ?? childText(element, "tmdbid"),
    imdb:
      unique.get("imdb") ??
      childText(element, "imdbid") ??
      (legacyId !== undefined && IMDB_ID.test(legacyId) ? legacyId : undefined),
    tvdb: unique.get("tvdb") ?? childText(element, "tvdbid"),
  };
};

const fromElement = (kind: NfoKind, element: XmlElement): LocalMetadata => {
  const releaseDate = isoDate(childText(element, "premiered") ?? childText(element, "aired"));
  const runtime = integer(childText(element, "runtime"));

  return {
    kind,
    title: childText(element, "title"),
    originalTitle: childText(element, "originaltitle"),
    sortTitle: childText(element, "sorttitle"),
    year: integer(childText(element, "year")) ?? integer(releaseDate?.slice(0, 4)),
    releaseDate,
    plot: childText(element, "plot") ?? childText(element, "outline"),
    tagline: childText(element, "tagline"),
    runtimeMinutes: runtime !== undefined && runtime > 0 ? runtime : undefined,
    contentRating: childText(element, "mpaa") ?? childText(element, "certification"),
    rating: ratingOf(element),
    genres: texts(element, "genre"),
    studios: texts(element, "studio"),
    ids: idsOf(element),
    season: integer(childText(element, "season")),
    episode: integer(childText(element, "episode")),
  };
};

const fromUrls = (kind: NfoKind, text: string): LocalMetadata | undefined => {
  const imdb = IMDB_ID.exec(text)?.[1];
  const tmdb = TMDB_URL.exec(text)?.[1];
  const tvdb = TVDB_URL.exec(text)?.[1];

  if (imdb === undefined && tmdb === undefined && tvdb === undefined) return undefined;

  return { kind, genres: [], studios: [], ids: { tmdb, imdb, tvdb } };
};

/**
 * Parses an NFO file of the expected kind. Returns `undefined` when the file has neither a
 * matching XML root nor a provider URL. For multi-episode NFO files, `episode` selects the
 * matching `<episodedetails>` block; the first one is used otherwise.
 */
export const parseNfo = (
  text: string,
  expected: NfoKind,
  episode?: number,
): LocalMetadata | undefined => {
  const roots = parseXml(text).filter((element) => ROOTS.get(element.name) === expected);

  const chosen =
    (episode === undefined
      ? undefined
      : roots.find((element) => integer(childText(element, "episode")) === episode)) ?? roots[0];

  return chosen === undefined ? fromUrls(expected, text) : fromElement(expected, chosen);
};
