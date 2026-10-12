import { describe, expect, it } from "@effect/vitest";

import { type MediaName, parseMediaPath } from "./media-naming.ts";

type Movie = Extract<MediaName, { readonly _tag: "Movie" }>;

type Episode = Extract<MediaName, { readonly _tag: "Episode" }>;

const noIds = { tmdb: undefined, imdb: undefined, tvdb: undefined };

const movie = (title: string, year?: number, extra: Partial<Movie> = {}): Movie => ({
  _tag: "Movie",
  title,
  year,
  edition: undefined,
  part: undefined,
  ids: noIds,
  ...extra,
});

const episode = (
  showTitle: string,
  season: number,
  episodes: Episode["episodes"],
  episodeTitle?: string,
  extra: Partial<Episode> = {},
): Episode => ({
  _tag: "Episode",
  showTitle,
  showYear: undefined,
  season,
  episodes,
  episodeTitle,
  showIds: noIds,
  ...extra,
});

describe("parseMediaPath", () => {
  it.each([
    ["Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv", movie("Big Buck Bunny", 2008)],
    ["The Matrix (1999)/the.matrix.1999.1080p.bluray.x264-grp.mkv", movie("The Matrix", 1999)],
    ["Messy.Release.Name.2012.1080p.BluRay.x264-GROUP.mkv", movie("Messy Release Name", 2012)],
    ["Blade_Runner_2049_2017_2160p_UHD.mkv", movie("Blade Runner 2049", 2017)],
    ["2001 A Space Odyssey (1968).mkv", movie("2001 A Space Odyssey", 1968)],
    ["1917.2019.1080p.WEB-DL.mkv", movie("1917", 2019)],
    ["Heat.1995.REMASTERED.1080p.mkv", movie("Heat", 1995)],
    ["Some Movie.mkv", movie("Some Movie")],
    ["Collection/Alien.1979.mkv", movie("Alien", 1979)],
    [
      "Blade Runner (1982)/Blade Runner (1982) {edition-Final Cut}.mkv",
      movie("Blade Runner", 1982, { edition: "Final Cut" }),
    ],
    ["Kill Bill (2003)/Kill Bill (2003) - part2.mkv", movie("Kill Bill", 2003, { part: 2 })],
    ["Old Movie (1950) - cd1.avi", movie("Old Movie", 1950, { part: 1 })],
    [
      "The Matrix (1999) [tmdbid-603]/The Matrix (1999) [imdbid-tt0133093].mkv",
      movie("The Matrix", 1999, { ids: { tmdb: "603", imdb: "tt0133093", tvdb: undefined } }),
    ],
  ])("parses movie %s", (path, expected) => {
    expect(parseMediaPath(path)).toStrictEqual(expected);
  });

  it.each([
    [
      "Fixture Show (2021)/Season 01/Fixture Show - S01E02 - Second.mkv",
      episode("Fixture Show", 1, [2], "Second", { showYear: 2021 }),
    ],
    [
      "Fixture Show (2021)/Season 01/Fixture Show - S01E03E04 - Double.mkv",
      episode("Fixture Show", 1, [3, 4], "Double", { showYear: 2021 }),
    ],
    ["Show/Season 1/Show S01E01-E03.mkv", episode("Show", 1, [1, 2, 3])],
    ["Show/Season 1/Show.S01E05-06.720p.mkv", episode("Show", 1, [5, 6])],
    [
      "Fixture Show (2021)/Season 02/Fixture.Show.S02E01.Return.720p.WEB-DL.mp4",
      episode("Fixture Show", 2, [1], "Return", { showYear: 2021 }),
    ],
    [
      "Fixture Show (2021)/Season 02/Fixture Show - 2x02 - Again.mp4",
      episode("Fixture Show", 2, [2], "Again", { showYear: 2021 }),
    ],
    [
      "Fixture Show (2021)/Specials/Fixture Show - S00E01 - Special.mkv",
      episode("Fixture Show", 0, [1], "Special", { showYear: 2021 }),
    ],
    ["Show/Specials/03 - Behind It All.mkv", episode("Show", 0, [3], "Behind It All")],
    ["Show/Season 03/07 - Seventh.mkv", episode("Show", 3, [7], "Seventh")],
    ["Show/Season 03/Episode 7.mkv", episode("Show", 3, [7])],
    [
      "Doctor.Who.2005.S10E01.The.Pilot.1080p.mkv",
      episode("Doctor Who", 10, [1], "The Pilot", { showYear: 2005 }),
    ],
    ["Show/s2e3.mkv", episode("Show", 2, [3])],
    [
      "Show (2010) [tvdbid-1234]/Season 1/Show - S01E01.mkv",
      episode("Show", 1, [1], undefined, {
        showYear: 2010,
        showIds: { tmdb: undefined, imdb: undefined, tvdb: "1234" },
      }),
    ],
  ])("parses episode %s", (path, expected) => {
    expect(parseMediaPath(path)).toStrictEqual(expected);
  });

  it.each([
    ["Movie (2000)/Trailers/Teaser.mkv", { _tag: "Extra", kind: "trailer", title: "Teaser" }],
    [
      "Movie (2000)/Movie (2000)-trailer.mkv",
      { _tag: "Extra", kind: "trailer", title: "Movie (2000)-trailer" },
    ],
    [
      "Movie (2000)/Behind The Scenes/Making Of.mkv",
      { _tag: "Extra", kind: "behind-the-scenes", title: "Making Of" },
    ],
    [
      "Movie.2000.1080p-sample.mkv",
      { _tag: "Extra", kind: "sample", title: "Movie 2000 1080p-sample" },
    ],
    ["Show/Season 1/Extras/Bloopers.mkv", { _tag: "Extra", kind: "extra", title: "Bloopers" }],
  ])("recognises extra %s", (path, expected) => {
    expect(parseMediaPath(path)).toStrictEqual(expected);
  });
});
