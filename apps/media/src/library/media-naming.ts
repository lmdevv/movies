/**
 * Infers what a media file is from its path inside a library: a movie, one or more episodes of
 * a show, or an extra such as a trailer. Handles the Plex/Jellyfin/Kodi folder conventions and
 * scene-release names. Pure: it reads only the path string.
 */
import { Schema } from "effect";

/** Provider IDs embedded in a name, such as `[tmdbid-603]` or `{imdb-tt0133093}`. */
export const NameIds = Schema.Struct({
  tmdb: Schema.optional(Schema.String),
  imdb: Schema.optional(Schema.String),
  tvdb: Schema.optional(Schema.String),
});

/** Provider IDs embedded in a name. */
export interface NameIds extends Schema.Schema.Type<typeof NameIds> {}

/** Kinds of extra material stored next to a title. */
export const ExtraKind = Schema.Literals([
  "trailer",
  "featurette",
  "behind-the-scenes",
  "deleted-scene",
  "interview",
  "scene",
  "short",
  "sample",
  "extra",
]);

/** Kinds of extra material stored next to a title. */
export type ExtraKind = typeof ExtraKind.Type;

/** What a media file's path says it is. */
export const MediaName = Schema.TaggedUnion({
  Movie: {
    title: Schema.String,
    year: Schema.optional(Schema.Int),
    /** Cut or version, such as `Director's Cut`. */
    edition: Schema.optional(Schema.String),
    /** Disc or part number of a movie split across files. */
    part: Schema.optional(Schema.Int),
    ids: NameIds,
  },
  Episode: {
    showTitle: Schema.String,
    showYear: Schema.optional(Schema.Int),
    /** 0 for specials. */
    season: Schema.Int,
    /** One entry per episode in the file, ascending; several for multi-episode files. */
    episodes: Schema.NonEmptyArray(Schema.Int),
    episodeTitle: Schema.optional(Schema.String),
    showIds: NameIds,
  },
  Extra: {
    kind: ExtraKind,
    title: Schema.String,
  },
});

/** What a media file's path says it is. */
export type MediaName = typeof MediaName.Type;

const EXTRA_FOLDERS: ReadonlyMap<string, ExtraKind> = new Map([
  ["extras", "extra"],
  ["extra", "extra"],
  ["featurettes", "featurette"],
  ["behind the scenes", "behind-the-scenes"],
  ["deleted scenes", "deleted-scene"],
  ["interviews", "interview"],
  ["scenes", "scene"],
  ["shorts", "short"],
  ["trailers", "trailer"],
  ["sample", "sample"],
  ["samples", "sample"],
  ["other", "extra"],
]);

const EXTRA_SUFFIXES: ReadonlyMap<string, ExtraKind> = new Map([
  ["trailer", "trailer"],
  ["featurette", "featurette"],
  ["behindthescenes", "behind-the-scenes"],
  ["deleted", "deleted-scene"],
  ["deletedscene", "deleted-scene"],
  ["interview", "interview"],
  ["scene", "scene"],
  ["short", "short"],
  ["sample", "sample"],
  ["extra", "extra"],
  ["other", "extra"],
]);

/** Tokens that start the technical tail of a scene-release name. */
const RELEASE_TAGS: ReadonlySet<string> = new Set([
  "2160p",
  "1440p",
  "1080p",
  "1080i",
  "720p",
  "576p",
  "480p",
  "4k",
  "uhd",
  "hdr",
  "hdr10",
  "hdr10+",
  "dv",
  "dovi",
  "sdr",
  "bluray",
  "blu-ray",
  "bdrip",
  "brrip",
  "bdremux",
  "remux",
  "web",
  "web-dl",
  "webdl",
  "webrip",
  "hdtv",
  "hdrip",
  "dvdrip",
  "dvdscr",
  "dvd",
  "xvid",
  "divx",
  "x264",
  "x265",
  "h264",
  "h265",
  "h.264",
  "h.265",
  "hevc",
  "avc",
  "av1",
  "aac",
  "ac3",
  "eac3",
  "dts",
  "dts-hd",
  "truehd",
  "atmos",
  "ddp",
  "ddp5.1",
  "dd5.1",
  "proper",
  "repack",
  "extended",
  "unrated",
  "limited",
  "internal",
  "multi",
  "10bit",
  "8bit",
  "nf",
  "amzn",
  "hulu",
  "dsnp",
  "atvp",
  "hmax",
  "imax",
]);

const SEASON_FOLDER = /^(?:season|series|staffel|saison|s)[ ._-]*(\d{1,3})$/i;

const SPECIALS_FOLDER = /^(?:specials?|season[ ._-]*0+)$/i;

const SXXEXX =
  /(?:^|[^a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})((?:[ ._-]*-?[ ._-]*e\d{1,4})*)(?:-(\d{1,4})(?!\d))?/i;

const NXNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:-?x?(\d{2,3}))?(?![a-z0-9])/i;

const LEADING_EPISODE = /^(?:e|ep|episode)?[ ._-]*(\d{1,3})(?=$|[ ._-])/i;

const YEAR_IN_PARENS = /[([](\d{4})[)\]]/;

const PART = /[ ._-]+(?:cd|part|pt|dis[ck])[ ._-]?(\d{1,2})$/i;

const EDITION = /\{edition-([^}]+)\}/i;

const ID_TAG = /[[{](tmdb|imdb|tvdb)(?:id)?[-=]([a-z0-9]+)[\]}]/gi;

const BRACKETED = /\[[^\]]*\]|\{[^}]*\}/g;

const isYear = (value: number): boolean => value >= 1900 && value <= 2099;

const stemOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, "");

const idsOf = (text: string): NameIds => {
  const found = new Map<string, string>();

  for (const match of text.matchAll(ID_TAG)) {
    if (match[1] !== undefined && match[2] !== undefined)
      found.set(match[1].toLowerCase(), match[2]);
  }

  return { tmdb: found.get("tmdb"), imdb: found.get("imdb"), tvdb: found.get("tvdb") };
};

/** IDs from `preferred`, falling back to `fallback` per provider. */
const mergeIds = (preferred: NameIds, fallback: NameIds): NameIds => ({
  tmdb: preferred.tmdb ?? fallback.tmdb,
  imdb: preferred.imdb ?? fallback.imdb,
  tvdb: preferred.tvdb ?? fallback.tvdb,
});

/** Collapses separators and drops bracketed tags so only the human-readable words remain. */
const words = (text: string): ReadonlyArray<string> => {
  const withoutTags = text.replace(BRACKETED, " ");
  const separated = withoutTags.includes(" ") ? withoutTags : withoutTags.replaceAll(/[._]/g, " ");

  return separated
    .replaceAll("_", " ")
    .split(/\s+/)
    .filter((word) => word !== "" && word !== "-");
};

const isReleaseTag = (word: string): boolean => {
  const lower = word.toLowerCase().replace(/^[([]|[)\]]$/g, "");

  return RELEASE_TAGS.has(lower) || RELEASE_TAGS.has(lower.split("-")[0] ?? "");
};

const tidy = (text: string): string =>
  text
    .replaceAll(/\s+/g, " ")
    .replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, "")
    .trim();

interface TitleYear {
  readonly title: string;
  readonly year: number | undefined;
}

/** Splits `Title (Year)` or `Title.Year.1080p.Tags` into a title and a year. */
const titleAndYear = (text: string): TitleYear => {
  const parenthesised = YEAR_IN_PARENS.exec(text);

  if (parenthesised?.[1] !== undefined && isYear(Number(parenthesised[1]))) {
    const title = tidy(words(text.slice(0, parenthesised.index)).join(" "));

    if (title !== "") return { title, year: Number(parenthesised[1]) };
  }

  const all = words(text);
  const tagIndex = all.findIndex((word, index) => index > 0 && isReleaseTag(word));
  const head = tagIndex === -1 ? all : all.slice(0, tagIndex);

  // The last year-like word that leaves a title before it: "2001 A Space Odyssey 1968".
  for (let index = head.length - 1; index > 0; index -= 1) {
    const candidate = (head[index] ?? "").replace(/^[([]|[)\]]$/g, "");

    if (/^\d{4}$/.test(candidate) && isYear(Number(candidate))) {
      return { title: tidy(head.slice(0, index).join(" ")), year: Number(candidate) };
    }
  }

  return { title: tidy(head.join(" ")), year: undefined };
};

const extraOf = (directories: ReadonlyArray<string>, stem: string): ExtraKind | undefined => {
  for (const directory of directories) {
    const kind = EXTRA_FOLDERS.get(directory.toLowerCase());

    if (kind !== undefined) return kind;
  }

  const suffix = /-([a-z]+)$/i.exec(stem)?.[1]?.toLowerCase();

  if (suffix !== undefined && EXTRA_SUFFIXES.has(suffix)) return EXTRA_SUFFIXES.get(suffix);

  return /(?:^|[ ._-])sample$/i.test(stem) ? "sample" : undefined;
};

const range = (first: number, last: number): ReadonlyArray<number> =>
  last > first && last - first < 50
    ? Array.from({ length: last - first + 1 }, (_, offset) => first + offset)
    : [first];

interface EpisodeMarker {
  readonly season: number;
  readonly episodes: readonly [number, ...Array<number>];
  /** Text before and after the marker in the file name. */
  readonly before: string;
  readonly after: string;
}

const episodeMarker = (stem: string): EpisodeMarker | undefined => {
  const standard = SXXEXX.exec(stem);

  if (standard !== null) {
    const first = Number(standard[2]);

    const listed = [...(standard[3] ?? "").matchAll(/e(\d{1,4})/gi)].map((match) =>
      Number(match[1]),
    );

    const last = standard[4] === undefined ? undefined : Number(standard[4]);
    const isRange = /-/.test(standard[3] ?? "") || last !== undefined;
    const end = last ?? listed.at(-1) ?? first;
    const more = isRange ? range(first, end).slice(1) : listed;

    return {
      season: Number(standard[1]),
      episodes: [first, ...more.filter((episode) => episode > first)],
      before: stem.slice(0, standard.index),
      after: stem.slice(standard.index + standard[0].length),
    };
  }

  const crossed = NXNN.exec(stem);

  if (crossed !== null) {
    const first = Number(crossed[2]);
    const last = crossed[3] === undefined ? first : Number(crossed[3]);

    return {
      season: Number(crossed[1]),
      episodes: [first, ...range(first, last).slice(1)],
      before: stem.slice(0, crossed.index),
      after: stem.slice(crossed.index + crossed[0].length),
    };
  }

  return undefined;
};

const seasonOfFolder = (folder: string): number | undefined => {
  if (SPECIALS_FOLDER.test(folder)) return 0;
  const match = SEASON_FOLDER.exec(folder);

  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const episodeTitleOf = (after: string): string | undefined => {
  const text = after.replace(/^[\s._-]+/, "");
  const [first] = words(text);

  if (first === undefined || isReleaseTag(first)) return undefined;
  const title = tidy(titleAndYear(text).title);

  return title === "" ? undefined : title;
};

const parseEpisode = (directories: ReadonlyArray<string>, stem: string): MediaName | undefined => {
  const lastFolder = directories.at(-1);
  const folderSeason = lastFolder === undefined ? undefined : seasonOfFolder(lastFolder);
  const showFolder = folderSeason === undefined ? lastFolder : directories.at(-2);
  const marker = episodeMarker(stem);
  const leading = folderSeason === undefined ? null : LEADING_EPISODE.exec(stem);

  if (marker === undefined && leading?.[1] === undefined) return undefined;

  const show = titleAndYear(showFolder ?? marker?.before ?? stem);
  const showTitle = show.title === "" ? tidy(words(marker?.before ?? "").join(" ")) : show.title;
  const showIds = idsOf(showFolder ?? "");

  if (marker !== undefined) {
    return MediaName.cases.Episode.make({
      showTitle: showTitle === "" ? stem : showTitle,
      showYear: show.year,
      season: marker.season,
      episodes: marker.episodes,
      episodeTitle: episodeTitleOf(marker.after),
      showIds,
    });
  }

  return MediaName.cases.Episode.make({
    showTitle: showTitle === "" ? stem : showTitle,
    showYear: show.year,
    season: folderSeason ?? 1,
    episodes: [Number(leading?.[1])],
    episodeTitle: episodeTitleOf(stem.slice(leading?.[0].length ?? 0)),
    showIds,
  });
};

const parseMovie = (directories: ReadonlyArray<string>, stem: string): MediaName => {
  const edition = EDITION.exec(stem)?.[1] ?? undefined;
  const part = PART.exec(stem);
  const fileText = (part === null ? stem : stem.slice(0, part.index)).replace(EDITION, " ");
  const fromFile = titleAndYear(fileText);
  const folder = directories.at(-1);
  const fromFolder = folder === undefined ? undefined : titleAndYear(folder.replace(EDITION, " "));

  const folderWins =
    fromFolder !== undefined &&
    fromFolder.title !== "" &&
    (YEAR_IN_PARENS.test(folder ?? "") ||
      fromFolder.title.toLowerCase() === fromFile.title.toLowerCase());

  const chosen = folderWins ? fromFolder : fromFile;

  return MediaName.cases.Movie.make({
    title: chosen.title === "" ? stem : chosen.title,
    year: chosen.year ?? fromFile.year,
    edition: edition === undefined ? undefined : tidy(edition),
    part: part?.[1] === undefined ? undefined : Number(part[1]),
    ids: folderWins ? mergeIds(idsOf(stem), idsOf(folder ?? "")) : idsOf(stem),
  });
};

/**
 * Parses the path of a media file relative to its library root (with `/` separators).
 *
 * Episodes need an `SxxEyy` or `NxNN` marker, or a leading number inside a `Season NN` or
 * `Specials` folder. Everything else is a movie, unless an `Extras`-style folder or a
 * `-trailer`-style suffix marks it as an extra.
 */
export const parseMediaPath = (relativePath: string): MediaName => {
  const segments = relativePath.split("/").filter((segment) => segment !== "");
  const fileName = segments.at(-1) ?? relativePath;
  const directories = segments.slice(0, -1);
  const stem = stemOf(fileName);
  const extra = extraOf(directories, stem);

  if (extra !== undefined) {
    return MediaName.cases.Extra.make({ kind: extra, title: tidy(words(stem).join(" ")) || stem });
  }

  return parseEpisode(directories, stem) ?? parseMovie(directories, stem);
};
