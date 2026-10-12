/**
 * The fixture catalog the fake media service "finds" when it scans: a handful of movies with
 * ratings for kids filtering, and a show with two seasons. Names carry the run's token so a search
 * finds this run's titles only, even on a stack reused across runs.
 */
import { ScannedItem } from "@movies/contracts/models/scan";
import { Schema } from "effect";

const decodeItem = Schema.decodeUnknownSync(ScannedItem);

const MINUTE_MS = 60_000;

/** A movie of the fixture catalog. */
interface FixtureMovie {
  readonly name: string;
  readonly year: number;
  readonly certification: string;
  readonly ageRating: number;
  readonly minutes: number;
  readonly genres: ReadonlyArray<string>;
}

/** Movies, from all-ages to adult, so kids profiles see some and not others. */
const MOVIES: ReadonlyArray<FixtureMovie> = [
  {
    name: "Dune Part Two",
    year: 2024,
    certification: "PG-13",
    ageRating: 13,
    minutes: 166,
    genres: ["Sci-fi", "Adventure"],
  },
  {
    name: "Past Lives",
    year: 2023,
    certification: "PG-13",
    ageRating: 13,
    minutes: 106,
    genres: ["Drama", "Romance"],
  },
  {
    name: "Perfect Days",
    year: 2023,
    certification: "PG",
    ageRating: 7,
    minutes: 124,
    genres: ["Drama"],
  },
  {
    name: "Arrival",
    year: 2016,
    certification: "PG-13",
    ageRating: 13,
    minutes: 116,
    genres: ["Sci-fi", "Drama"],
  },
  {
    name: "Spirited Away",
    year: 2001,
    certification: "PG",
    ageRating: 7,
    minutes: 125,
    genres: ["Animation", "Fantasy"],
  },
  {
    name: "Sicario",
    year: 2015,
    certification: "R",
    ageRating: 17,
    minutes: 121,
    genres: ["Thriller", "Crime"],
  },
  {
    name: "Paddington Two",
    year: 2017,
    certification: "PG",
    ageRating: 7,
    minutes: 103,
    genres: ["Comedy", "Family"],
  },
  {
    name: "Blade Runner 2049",
    year: 2017,
    certification: "R",
    ageRating: 17,
    minutes: 164,
    genres: ["Sci-fi", "Thriller"],
  },
  {
    name: "My Neighbor Totoro",
    year: 1988,
    certification: "G",
    ageRating: 0,
    minutes: 86,
    genres: ["Animation", "Family"],
  },
  {
    name: "Aftersun",
    year: 2022,
    certification: "R",
    ageRating: 17,
    minutes: 102,
    genres: ["Drama"],
  },
];

/** The show: two seasons of short episodes. */
const SHOW = {
  name: "Severance",
  year: 2022,
  certification: "TV-MA",
  ageRating: 17,
  seasons: [
    ["Good News About Hell", "Half Loop", "In Perpetuity", "The You You Are"],
    ["Hello, Ms. Cobel", "Goodbye, Mrs. Selvig", "Who Is Alive?", "Woe's Hollow", "Trojan's Horse"],
  ],
} as const;

/** The title's name with the run's token, if any. */
const named = (name: string, token: string): string => (token === "" ? name : `${name} ${token}`);

const slug = (text: string): string => text.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");

const probe = (minutes: number, width: number, height: number) => ({
  container: "matroska",
  durationMs: minutes * MINUTE_MS,
  bitRate: 12_000_000,
  video: [
    {
      index: 0,
      codec: "hevc",
      profile: "Main 10",
      width,
      height,
      frameRate: 23.976,
      bitDepth: 10,
      pixelFormat: "yuv420p10le",
      hdr: width >= 3800 ? "hdr10" : "none",
      bitRate: null,
    },
  ],
  audio: [
    {
      index: 1,
      codec: "eac3",
      profile: null,
      channels: 6,
      channelLayout: "5.1(side)",
      language: "eng",
      title: null,
      default: true,
      bitRate: 640_000,
    },
  ],
  subtitles: [
    {
      index: 2,
      codec: "subrip",
      kind: "text",
      language: "eng",
      title: null,
      default: false,
      forced: false,
    },
  ],
});

const art = (name: string) => ({
  poster: `poster/${slug(name)}.svg`,
  backdrop: `backdrop/${slug(name)}.svg`,
  logo: null,
});

/** The movies as scanned files under `root`, with `token` in each name. */
export const movieItems = (root: string, token: string): ReadonlyArray<ScannedItem> =>
  MOVIES.map((movie, index) =>
    decodeItem({
      file: {
        path: `${root}/${movie.name} (${movie.year})/${movie.name}.mkv`,
        sizeBytes: 8_000_000_000 + index,
        mtimeMs: 1_760_000_000_000,
        probe: probe(movie.minutes, index % 3 === 0 ? 3840 : 1920, index % 3 === 0 ? 2160 : 1080),
        externalSubtitles: [],
        versionName: null,
      },
      title: {
        kind: "movie",
        matchKey: `local:${slug(movie.name)}-${token}`,
        name: named(movie.name, token),
        sortName: null,
        year: movie.year,
        overview: `${movie.name} is part of the fixture library the end-to-end tests scan.`,
        tagline: null,
        genres: movie.genres,
        certification: movie.certification,
        ageRating: movie.ageRating,
        runtimeMs: movie.minutes * MINUTE_MS,
        artwork: art(movie.name),
        externalIds: { tmdb: null, imdb: null, tvdb: null },
        matchStatus: "matched",
      },
      episode: null,
    }),
  );

/** The show's episodes as scanned files under `root`. */
export const showItems = (root: string, token: string): ReadonlyArray<ScannedItem> =>
  SHOW.seasons.flatMap((episodes, seasonIndex) =>
    episodes.map((name, episodeIndex) =>
      decodeItem({
        file: {
          path: `${root}/${SHOW.name}/Season ${seasonIndex + 1}/S0${seasonIndex + 1}E0${episodeIndex + 1}.mkv`,
          sizeBytes: 2_000_000_000,
          mtimeMs: 1_760_000_000_000,
          probe: probe(50, 3840, 2160),
          externalSubtitles: [],
          versionName: null,
        },
        title: {
          kind: "show",
          matchKey: `local:${slug(SHOW.name)}-${token}`,
          name: named(SHOW.name, token),
          sortName: null,
          year: SHOW.year,
          overview: "Office workers whose memories are surgically divided between work and home.",
          tagline: null,
          genres: ["Sci-fi", "Thriller", "Drama"],
          certification: SHOW.certification,
          ageRating: SHOW.ageRating,
          runtimeMs: 50 * MINUTE_MS,
          artwork: art(SHOW.name),
          externalIds: { tmdb: null, imdb: null, tvdb: null },
          matchStatus: "matched",
        },
        episode: {
          seasonNumber: seasonIndex + 1,
          episodeNumber: episodeIndex + 1,
          name,
          overview: `${name}: episode ${episodeIndex + 1} of season ${seasonIndex + 1}.`,
          airDate: null,
          runtimeMs: 50 * MINUTE_MS,
          still: `still/${slug(SHOW.name)}-${seasonIndex + 1}-${episodeIndex + 1}.svg`,
          seasonName: `Season ${seasonIndex + 1}`,
          seasonPoster: null,
        },
      }),
    ),
  );
