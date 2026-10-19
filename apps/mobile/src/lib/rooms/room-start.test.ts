import { EpisodeId, SeasonId, TitleId } from "@movies/contracts/ids";
import type { Episode, Progress } from "@movies/contracts/models/catalog";
import { EpochMillis, Milliseconds } from "@movies/contracts/units";
import { describe, expect, it } from "vitest";

import { roomStart } from "./room-start";

const progress = (positionMs: number, watched = false): Progress => ({
  positionMs: Milliseconds.make(positionMs),
  durationMs: Milliseconds.make(9_000_000),
  watched,
  updatedAt: EpochMillis.make(0),
});

const episode = (saved: Progress | null): Episode => ({
  id: EpisodeId.make("e4"),
  titleId: TitleId.make("severance"),
  seasonId: SeasonId.make("s1"),
  seasonNumber: 1,
  episodeNumber: 4,
  name: "The You You Are",
  overview: null,
  airDate: null,
  runtimeMs: null,
  still: null,
  rating: null,
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  available: true,
  progress: saved,
});

describe("roomStart", () => {
  it("starts a movie where the profile stopped, or over once watched", () => {
    expect(roomStart({ kind: "movie", progress: progress(5_598_000), nextEpisode: null })).toEqual({
      episodeId: undefined,
      positionMs: 5_598_000,
      episode: null,
    });

    expect(
      roomStart({ kind: "movie", progress: progress(9_000_000, true), nextEpisode: null })
        .positionMs,
    ).toBe(0);

    expect(roomStart({ kind: "movie", progress: null, nextEpisode: null }).positionMs).toBe(0);
  });

  it("starts a show's next episode where the profile stopped in it", () => {
    const next = episode(progress(60_000));

    expect(roomStart({ kind: "show", progress: null, nextEpisode: next })).toEqual({
      episodeId: next.id,
      positionMs: 60_000,
      episode: next,
    });

    expect(roomStart({ kind: "show", progress: null, nextEpisode: episode(null) }).positionMs).toBe(
      0,
    );
  });

  it("lets the server choose a show's episode when none is next", () => {
    expect(roomStart({ kind: "show", progress: null, nextEpisode: null })).toEqual({
      episodeId: undefined,
      positionMs: 0,
      episode: null,
    });
  });
});
