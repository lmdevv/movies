/**
 * Finds local artwork next to media using the Kodi/Jellyfin/Plex file names. Pure: callers pass
 * the names in a folder; results are paths relative to the library root.
 */
import { Schema } from "effect";

/** Local images for a title, season, or episode, as paths relative to the library root. */
export const Artwork = Schema.Struct({
  poster: Schema.optional(Schema.String),
  backdrop: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  banner: Schema.optional(Schema.String),
  /** Landscape still: an episode thumbnail or a movie's `landscape` image. */
  thumb: Schema.optional(Schema.String),
});

/** Local images for a title, season, or episode. */
export interface Artwork extends Schema.Schema.Type<typeof Artwork> {}

/** The entries of one folder, relative to the library root (`""` for the root itself). */
export interface FolderListing {
  readonly folder: string;
  readonly names: ReadonlyArray<string>;
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "tbn"];

const join = (folder: string, name: string): string => (folder === "" ? name : `${folder}/${name}`);

/** The first existing image among `bases` (without extension), compared case-insensitively. */
const findImage = (listing: FolderListing, bases: ReadonlyArray<string>): string | undefined => {
  const byLowerName = new Map(listing.names.map((name) => [name.toLowerCase(), name]));

  for (const base of bases) {
    for (const extension of IMAGE_EXTENSIONS) {
      const name = byLowerName.get(`${base}.${extension}`.toLowerCase());

      if (name !== undefined) return join(listing.folder, name);
    }
  }

  return undefined;
};

const stemOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, "");

const fileNameOf = (relativePath: string): string => relativePath.split("/").at(-1) ?? relativePath;

/**
 * Artwork for a movie file. `ownFolder` says the folder holds only this movie, so generic names
 * such as `poster.jpg` belong to it; otherwise only `<movie>-poster.jpg`-style names count.
 */
export const movieArtwork = (
  mediaPath: string,
  listing: FolderListing,
  ownFolder: boolean,
): Artwork => {
  const stem = stemOf(fileNameOf(mediaPath));

  const names = (suffixes: ReadonlyArray<string>, generic: ReadonlyArray<string>) => [
    ...suffixes.map((suffix) => `${stem}-${suffix}`),
    ...(ownFolder ? generic : []),
  ];

  return {
    poster: findImage(listing, names(["poster"], ["poster", "folder", "cover", "movie"])),
    backdrop: findImage(
      listing,
      names(["fanart", "backdrop"], ["fanart", "backdrop", "background", "art"]),
    ),
    logo: findImage(listing, names(["clearlogo", "logo"], ["clearlogo", "logo"])),
    banner: findImage(listing, names(["banner"], ["banner"])),
    thumb: findImage(listing, names(["landscape", "thumb"], ["landscape", "thumb"])),
  };
};

/** Artwork in a show's top folder. */
export const showArtwork = (listing: FolderListing): Artwork => ({
  poster: findImage(listing, ["poster", "folder", "cover", "show"]),
  backdrop: findImage(listing, ["fanart", "backdrop", "background", "art"]),
  logo: findImage(listing, ["clearlogo", "logo"]),
  banner: findImage(listing, ["banner"]),
  thumb: findImage(listing, ["landscape", "thumb"]),
});

/**
 * Poster for a season: `season01-poster.jpg` (or `season-specials-poster.jpg`) in the show
 * folder first, then `folder.jpg` or `poster.jpg` inside the season folder.
 */
export const seasonPoster = (
  season: number,
  showListing: FolderListing,
  seasonListing: FolderListing | undefined,
): string | undefined => {
  const padded = String(season).padStart(2, "0");

  const named =
    season === 0 ? ["season-specials-poster", "season00-poster"] : [`season${padded}-poster`];

  return (
    findImage(showListing, named) ??
    (seasonListing === undefined
      ? undefined
      : findImage(seasonListing, ["folder", "poster", "cover"]))
  );
};

/** Thumbnail for an episode file: `<episode>-thumb.jpg` or `<episode>.jpg` beside it. */
export const episodeThumb = (mediaPath: string, listing: FolderListing): string | undefined => {
  const stem = stemOf(fileNameOf(mediaPath));

  return findImage(listing, [`${stem}-thumb`, stem]);
};

/** The folder Kodi and Jellyfin keep actor photos in, next to the NFO. */
export const ACTORS_FOLDER = ".actors";

/**
 * An actor's photo in an `.actors` folder listing: `Jane_Doe.jpg`, as Kodi names them, or
 * `Jane Doe.jpg`.
 */
export const actorImage = (listing: FolderListing, name: string): string | undefined =>
  findImage(listing, [name.replaceAll(" ", "_"), name]);
