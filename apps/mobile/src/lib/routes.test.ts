import { EpisodeId, MediaFileId, TitleId } from "@movies/contracts/ids";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { watchHref } from "./routes";

const titleId = Schema.decodeSync(TitleId);

const episodeId = Schema.decodeSync(EpisodeId);

const fileId = Schema.decodeSync(MediaFileId);

describe("watchHref", () => {
  it("plays a movie from its saved position with no query", () => {
    expect(watchHref({ titleId: titleId("t1") })).toBe("/watch/t1");
  });

  it("names the episode, the version, and Start Over in a fixed order", () => {
    expect(
      watchHref({
        titleId: titleId("t1"),
        episodeId: episodeId("e2"),
        fileId: fileId("f3"),
        start: "beginning",
      }),
    ).toBe("/watch/t1?episodeId=e2&fileId=f3&start=beginning");

    expect(watchHref({ titleId: titleId("t1"), fileId: fileId("f3") })).toBe("/watch/t1?fileId=f3");

    expect(watchHref({ titleId: titleId("t1"), episodeId: undefined, start: "beginning" })).toBe(
      "/watch/t1?start=beginning",
    );
  });

  it("reads back through URLSearchParams whatever the IDs contain", () => {
    // Dot segments are not IDs; URL parsing would resolve them away.
    const id = fc.string({ minLength: 1 }).filter((value) => value !== "." && value !== "..");

    fc.assert(
      fc.property(
        id,
        fc.option(id, { nil: undefined }),
        fc.option(id, { nil: undefined }),
        fc.boolean(),
        (title, episode, file, beginning) => {
          const href = watchHref({
            titleId: titleId(title),
            episodeId: episode === undefined ? undefined : episodeId(episode),
            fileId: file === undefined ? undefined : fileId(file),
            start: beginning ? "beginning" : undefined,
          });

          const url = new URL(href, "movies://app");
          const query = new URLSearchParams(url.search);

          expect(decodeURIComponent(url.pathname)).toBe(`/watch/${title}`);
          expect(query.get("episodeId") ?? undefined).toBe(episode);
          expect(query.get("fileId") ?? undefined).toBe(file);
          expect(query.get("start")).toBe(beginning ? "beginning" : null);
        },
      ),
    );
  });
});
