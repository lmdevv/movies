/**
 * What a title's screens say, worked out from the server's data: the Play button, the facts line,
 * episode rows, season rows, the About list, the cast and crew rows, and the version offered first.
 * Pure, so it is tested without React Native.
 */
import type { EpisodeId, PersonId } from "@movies/contracts/ids";
import type {
  Credit,
  CreditKind,
  Episode,
  MediaVersion,
  Progress,
  Season,
  ShowStatus,
  TitleDetail,
} from "@movies/contracts/models/catalog";
import { MediaLabels } from "@movies/sdk/effect";

import { facts, formatRemaining, formatRuntime } from "@/lib/format";

/** `S2, E3`, how the title screens name an episode. */
const episodeShort = (episode: Pick<Episode, "seasonNumber" | "episodeNumber">): string =>
  `S${episode.seasonNumber}, E${episode.episodeNumber}`;

/** `1 Episode`, `10 Seasons`: a count with its noun in title case. */
const countOf = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** Where a profile is in a movie or an episode it started and has not finished. */
export interface Resume {
  readonly positionMs: number;
  readonly remainingMs: number;
}

/** The resume point of `progress`, or null when it is unstarted or watched. */
export const resumeOf = (progress: Progress | null): Resume | null =>
  progress === null || progress.watched || progress.positionMs <= 0 || progress.durationMs <= 0
    ? null
    : {
        positionMs: progress.positionMs,
        remainingMs: Math.max(0, progress.durationMs - progress.positionMs),
      };

/** What the main button of a title does. */
export interface PlayAction {
  /** `Play`, `Resume · 1h 12m left`, `Resume · S2, E3`, or `Play · S1, E1`. */
  readonly label: string;
  /** The episode it plays, for shows; undefined lets the player choose. */
  readonly episodeId: EpisodeId | undefined;
  /** It continues from saved progress, so Play from Beginning is worth offering. */
  readonly resuming: boolean;
}

/** The main button of `title`: start or resume the movie, or the show's next episode. */
export const playAction = (title: TitleDetail): PlayAction => {
  if (title.kind === "movie") {
    const resume = resumeOf(title.progress);

    return resume === null
      ? { label: "Play", episodeId: undefined, resuming: false }
      : {
          label: `Resume · ${formatRemaining(resume.remainingMs)}`,
          episodeId: undefined,
          resuming: true,
        };
  }

  const next = title.nextEpisode;

  if (next === null) return { label: "Play", episodeId: undefined, resuming: false };

  const resuming = resumeOf(next.progress) !== null;

  return {
    label: `${resuming ? "Resume" : "Play"} · ${episodeShort(next)}`,
    episodeId: next.id,
    resuming,
  };
};

/** The best version's picture class, such as `4K`, for the facts line. */
const pictureOf = (versions: ReadonlyArray<MediaVersion>): string | null => {
  const best = versions[0];

  return best === undefined || best.width === null || best.height === null
    ? null
    : MediaLabels.resolutionLabel(best.width, best.height);
};

/**
 * The line under the title: `2024 · 2h 46m · PG-13 · 4K` for a movie, `Thriller · 2 seasons ·
 * TV-MA` for a show.
 */
export const titleFacts = (title: TitleDetail): string =>
  title.kind === "movie"
    ? facts(
        title.year,
        title.runtimeMs === null ? null : formatRuntime(title.runtimeMs),
        title.certification,
        pictureOf(title.versions),
      )
    : facts(
        title.genres[0],
        title.seasons.length === 0
          ? null
          : `${title.seasons.length} ${title.seasons.length === 1 ? "season" : "seasons"}`,
        title.certification,
      );

/** Whether the profile has finished the whole title. */
export const isWatched = (title: TitleDetail): boolean =>
  title.kind === "movie"
    ? title.progress?.watched === true
    : title.nextEpisode === null && title.seasons.length > 0;

/** What an episode row shows. */
export interface EpisodeLine {
  /** `3. Who Is Alive?` */
  readonly heading: string;
  /** `53m · 38m left`, `47m`, or `53m · File missing`. */
  readonly meta: string;
  /** Finished, drawn with a full progress line. */
  readonly watched: boolean;
}

/** The text of an episode's row. */
export const episodeLine = (episode: Episode): EpisodeLine => {
  const runtime = episode.runtimeMs === null ? null : formatRuntime(episode.runtimeMs);
  const resume = resumeOf(episode.progress);

  return {
    heading: `${episode.episodeNumber}. ${episode.name}`,
    meta: facts(
      runtime,
      !episode.available
        ? "File missing"
        : resume === null
          ? null
          : formatRemaining(resume.remainingMs),
    ),
    watched: episode.progress?.watched === true,
  };
};

/** `Season 2, Episode 3 · 53m`, under an episode's name in its actions. */
export const episodeSubtitle = (episode: Episode): string =>
  facts(
    `Season ${episode.seasonNumber}, Episode ${episode.episodeNumber}`,
    episode.runtimeMs === null ? null : formatRuntime(episode.runtimeMs),
  );

/** `10 Episodes · Selected`, beside a season in the season picker. */
export const seasonDetail = (season: Season, selected: boolean): string =>
  facts(countOf(season.episodeCount, "Episode", "Episodes"), selected ? "Selected" : null);

/** The season the episode list opens on: the next episode's, else the first. */
export const initialSeason = (title: TitleDetail): number | null =>
  title.nextEpisode?.seasonNumber ?? title.seasons[0]?.seasonNumber ?? null;

/** The version offered first: the one this profile last played, else the best quality. */
export const defaultVersion = (versions: ReadonlyArray<MediaVersion>): MediaVersion | undefined =>
  versions.find((version) => version.lastPlayed) ?? versions[0];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** `March 1, 2024` for `2024-03-01`; anything else as given. */
export const formatLongDate = (iso: string): string => {
  const [, year, month, day] = ISO_DATE.exec(iso) ?? [];
  const name = month === undefined ? undefined : MONTHS[Number(month) - 1];

  return year === undefined || day === undefined || name === undefined
    ? iso
    : `${name} ${Number(day)}, ${year}`;
};

const STATUS_LABELS: Readonly<Record<ShowStatus, string>> = {
  returning: "Returning Series",
  ended: "Ended",
  canceled: "Canceled",
  "in-production": "In Production",
  planned: "Planned",
};

const CREW_LINES: ReadonlyArray<readonly [CreditKind, string]> = [
  ["creator", "Created by"],
  ["director", "Directed by"],
  ["writer", "Written by"],
  ["composer", "Music by"],
];

/** One fact on the About screen. */
export interface AboutRow {
  readonly label: string;
  readonly value: string;
}

/** `IMDb 7.9 · RT 88% · MC 73 · TMDB 7.1`, the scores a title has. */
const scoresOf = (ratings: TitleDetail["ratings"]): string =>
  facts(
    ratings.imdb === null ? null : `IMDb ${ratings.imdb.value.toFixed(1)}`,
    ratings.rottenTomatoes === null ? null : `RT ${ratings.rottenTomatoes}%`,
    ratings.metacritic === null ? null : `MC ${ratings.metacritic}`,
    ratings.tmdb === null ? null : `TMDB ${ratings.tmdb.value.toFixed(1)}`,
  );

/** Names of the people credited as `kind`, once each, joined with commas. */
const namesOf = (credits: ReadonlyArray<Credit>, kind: CreditKind): string =>
  [...new Set(credits.flatMap((credit) => (credit.kind === kind ? [credit.name] : [])))].join(", ");

/** The facts the About screen lists, only those the title has. */
export const aboutRows = (title: TitleDetail): ReadonlyArray<AboutRow> => {
  const show = title.kind === "show";
  const episodes = title.seasons.reduce((sum, season) => sum + season.episodeCount, 0);

  const rows: ReadonlyArray<readonly [string, string | null]> = [
    [
      show ? "First Aired" : "Released",
      title.releaseDate === null
        ? title.year === null
          ? null
          : String(title.year)
        : formatLongDate(title.releaseDate),
    ],
    show
      ? [
          "Seasons",
          title.seasons.length === 0
            ? null
            : facts(
                countOf(title.seasons.length, "Season", "Seasons"),
                countOf(episodes, "Episode", "Episodes"),
              ),
        ]
      : ["Duration", title.runtimeMs === null ? null : formatRuntime(title.runtimeMs)],
    [title.genres.length > 1 ? "Genres" : "Genre", title.genres.join(", ")],
    ["Rating", title.certification],
    ["Status", title.status === null ? null : STATUS_LABELS[title.status]],
    [show ? "Network" : "Studio", title.studios.join(", ")],
    ["Scores", scoresOf(title.ratings)],
    [
      "Original Title",
      title.originalName === null || title.originalName === title.name ? null : title.originalName,
    ],
    ...CREW_LINES.map(([kind, label]) => [label, namesOf(title.crew, kind)] as const),
  ];

  return rows.flatMap(([label, value]) =>
    value === null || value === "" ? [] : [{ label, value }],
  );
};

/** One person in the Cast & Crew list. */
export interface PersonLine {
  readonly personId: PersonId;
  readonly name: string;
  /** The character an actor plays, or a job such as `Director`. */
  readonly role: string | null;
  /** The person's photo as an artwork key. */
  readonly photo: string | null;
}

const JOB_NAMES: Readonly<Partial<Record<CreditKind, string>>> = {
  creator: "Creator",
  director: "Director",
};

/** Actors the Cast & Crew list names before the creators and directors. */
const CAST_LIMIT = 6;

/** The billed cast, then the creators and directors, each person once. */
export const castAndCrew = (title: TitleDetail): ReadonlyArray<PersonLine> => {
  const seen = new Set<string>();

  return [
    ...title.cast.slice(0, CAST_LIMIT).map((credit) => ({ credit, role: credit.role })),
    ...title.crew.flatMap((credit) => {
      const job = JOB_NAMES[credit.kind];

      return job === undefined ? [] : [{ credit, role: job }];
    }),
  ].flatMap(({ credit, role }) => {
    if (seen.has(credit.personId)) return [];
    seen.add(credit.personId);

    return [{ personId: credit.personId, name: credit.name, role, photo: credit.profile }];
  });
};
