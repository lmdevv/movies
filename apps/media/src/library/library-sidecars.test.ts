import { describe, expect, it } from "@effect/vitest";

import { episodeThumb, movieArtwork, seasonPoster, showArtwork } from "./artwork.ts";
import { sidecarSubtitles } from "./sidecar-subtitles.ts";

describe("artwork", () => {
  it("uses generic names only when the movie has its own folder", () => {
    const listing = {
      folder: "Movie (2000)",
      names: ["Movie (2000).mkv", "Poster.JPG", "fanart.jpg", "Movie (2000)-clearlogo.png"],
    };

    expect(movieArtwork("Movie (2000)/Movie (2000).mkv", listing, true)).toStrictEqual({
      poster: "Movie (2000)/Poster.JPG",
      backdrop: "Movie (2000)/fanart.jpg",
      logo: "Movie (2000)/Movie (2000)-clearlogo.png",
      banner: undefined,
      thumb: undefined,
    });

    expect(movieArtwork("Movie (2000)/Movie (2000).mkv", listing, false).poster).toBeUndefined();
  });

  it("finds show, season, and episode images", () => {
    const show = {
      folder: "Show",
      names: ["folder.jpg", "backdrop.png", "season01-poster.jpg", "season-specials-poster.jpg"],
    };

    const seasonTwo = {
      folder: "Show/Season 02",
      names: ["poster.webp", "Show - S02E01-thumb.jpg", "Show - S02E01.mkv"],
    };

    expect(showArtwork(show).poster).toBe("Show/folder.jpg");
    expect(showArtwork(show).backdrop).toBe("Show/backdrop.png");
    expect(seasonPoster(1, show, undefined)).toBe("Show/season01-poster.jpg");
    expect(seasonPoster(0, show, undefined)).toBe("Show/season-specials-poster.jpg");
    expect(seasonPoster(2, show, seasonTwo)).toBe("Show/Season 02/poster.webp");
    expect(episodeThumb("Show/Season 02/Show - S02E01.mkv", seasonTwo)).toBe(
      "Show/Season 02/Show - S02E01-thumb.jpg",
    );
  });
});

describe("sidecarSubtitles", () => {
  it("parses language, forced, hearing-impaired, and default flags", () => {
    const listing = {
      folder: "Movie (2000)",
      names: [
        "Movie (2000).mkv",
        "Movie (2000).srt",
        "Movie (2000).en.srt",
        "movie (2000).French.forced.ass",
        "Movie (2000).eng.sdh.default.vtt",
        "Movie (2000).en.Commentary.srt",
        "Movie (2000).idx",
        "Other Movie.en.srt",
      ],
    };

    expect(sidecarSubtitles("Movie (2000)/Movie (2000).mkv", listing)).toStrictEqual([
      {
        path: "Movie (2000)/Movie (2000).srt",
        format: "srt",
        language: undefined,
        title: undefined,
        forced: false,
        hearingImpaired: false,
        default: false,
      },
      {
        path: "Movie (2000)/Movie (2000).en.srt",
        format: "srt",
        language: "eng",
        title: undefined,
        forced: false,
        hearingImpaired: false,
        default: false,
      },
      {
        path: "Movie (2000)/movie (2000).French.forced.ass",
        format: "ass",
        language: "fre",
        title: undefined,
        forced: true,
        hearingImpaired: false,
        default: false,
      },
      {
        path: "Movie (2000)/Movie (2000).eng.sdh.default.vtt",
        format: "vtt",
        language: "eng",
        title: undefined,
        forced: false,
        hearingImpaired: true,
        default: true,
      },
      {
        path: "Movie (2000)/Movie (2000).en.Commentary.srt",
        format: "srt",
        language: "eng",
        title: "Commentary",
        forced: false,
        hearingImpaired: false,
        default: false,
      },
    ]);
  });

  it("reads Persian and keeps a regional variant as the title", () => {
    const listing = {
      folder: "Tears of Steel (2012)",
      names: ["Tears of Steel (2012).fa.srt", "Tears of Steel (2012).pt.Brazil.srt"],
    };

    expect(
      sidecarSubtitles("Tears of Steel (2012)/Tears of Steel (2012).mov", listing).map(
        ({ language, title }) => ({ language, title }),
      ),
    ).toStrictEqual([
      { language: "per", title: undefined },
      { language: "por", title: "Brazil" },
    ]);
  });
});
