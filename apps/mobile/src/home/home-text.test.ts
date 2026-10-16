import { ContinueWatchingItem, Home, TitleCard } from "@movies/contracts/models/catalog";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { billboardFacts, billboardTitle, continueText, heroTitles } from "./home-text";

const title = (id: string, addedAt: number, backdrop: string | null = `a1.${id}`) =>
  Schema.decodeSync(TitleCard)({
    id,
    kind: "movie",
    name: `Title ${id}`,
    year: 2024,
    certification: "PG-13",
    ageRating: null,
    runtimeMs: 166 * 60_000,
    genres: ["Sci-fi", "Adventure"],
    artwork: { poster: null, backdrop, logo: null },
    available: true,
    addedAt,
  });

const home = (featured: TitleCard | null, movies: ReadonlyArray<TitleCard>) =>
  Schema.decodeSync(Home)({
    featured,
    continueWatching: [],
    myList: [],
    recentlyAddedMovies: movies,
    recentlyAddedShows: [],
  });

const episode = {
  id: "e1",
  titleId: "show",
  seasonId: "s2",
  seasonNumber: 2,
  episodeNumber: 4,
  name: "Woe's Hollow",
  overview: null,
  airDate: null,
  runtimeMs: 52 * 60_000,
  still: null,
  rating: null,
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  available: true,
  progress: null,
};

const continueItem = (input: {
  readonly reason: "resume" | "next";
  readonly episode: typeof episode | null;
  readonly leftMinutes: number | null;
}) =>
  Schema.decodeSync(ContinueWatchingItem)({
    reason: input.reason,
    title: { ...title("show", 0), kind: "show", name: "Severance" },
    episode: input.episode,
    progress:
      input.leftMinutes === null
        ? null
        : {
            positionMs: 11 * 60_000,
            durationMs: (11 + input.leftMinutes) * 60_000,
            watched: false,
            updatedAt: 0,
          },
  });

describe("heroTitles", () => {
  it("leads with the featured title, then the newest arrivals with a backdrop, once each", () => {
    const featured = title("dune", 5);

    const titles = heroTitles(
      home(featured, [title("old", 1), featured, title("bare", 9, null), title("new", 7)]),
    );

    expect(titles.map((entry) => entry.id)).toStrictEqual(["dune", "new", "old"]);
  });

  it("pages through five titles at most", () => {
    const movies = Array.from({ length: 8 }, (_, index) => title(`m${String(index)}`, index));

    expect(heroTitles(home(null, movies))).toHaveLength(5);
  });
});

describe("billboardTitle", () => {
  it("splits a subtitle after a colon or a dash", () => {
    expect(billboardTitle("Dune: Part Two")).toStrictEqual({ main: "Dune", subtitle: "Part Two" });
    expect(billboardTitle("Alien – Romulus")).toStrictEqual({ main: "Alien", subtitle: "Romulus" });
  });

  it("keeps names without one whole", () => {
    expect(billboardTitle("Spider-Man")).toStrictEqual({ main: "Spider-Man", subtitle: null });
    expect(billboardTitle("Arrival")).toStrictEqual({ main: "Arrival", subtitle: null });
  });
});

describe("billboardFacts", () => {
  it("reads kind, first genre, year, and certification", () => {
    expect(billboardFacts(title("dune", 0))).toBe("Movie · Sci-fi · 2024 · PG-13");
  });
});

describe("continueText", () => {
  it("names the episode and the time left when resuming", () => {
    expect(
      continueText(continueItem({ reason: "resume", episode, leftMinutes: 41 })),
    ).toStrictEqual({ artTitle: "Severance", title: "Severance · S2:E4", subtitle: "41m left" });
  });

  it("says Next for a show's next episode", () => {
    expect(
      continueText(continueItem({ reason: "next", episode, leftMinutes: null })).subtitle,
    ).toBe("Next");
  });

  it("uses the movie's name without an episode", () => {
    expect(
      continueText(continueItem({ reason: "resume", episode: null, leftMinutes: 63 })),
    ).toStrictEqual({ artTitle: "Severance", title: "Severance", subtitle: "1h 03m left" });
  });
});
