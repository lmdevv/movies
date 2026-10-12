import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { ArtworkSource, make } from "./artwork-keys.ts";

const keys = make(Buffer.alloc(32, 7));

const other = make(Buffer.alloc(32, 8));

describe("ArtworkKeys", () => {
  it.effect("seals a source into an opaque, deterministic key and opens it again", () =>
    Effect.gen(function* () {
      const source = ArtworkSource.Local({ path: "/media/Movies/Heat (1995)/poster.jpg" });
      const key = yield* keys.seal(source);

      expect(key).toMatch(/^a1\.[\w-]+$/u);
      expect(key).not.toContain("Heat");
      expect(yield* keys.seal(source)).toBe(key);
      expect(yield* keys.open(key)).toStrictEqual(Option.some(source));

      const remote = ArtworkSource.Remote({ url: "https://image.tmdb.org/t/p/w500/a.jpg" });

      expect(yield* keys.open(yield* keys.seal(remote))).toStrictEqual(Option.some(remote));
    }),
  );

  it.effect("refuses keys it did not seal", () =>
    Effect.gen(function* () {
      const key = yield* keys.seal(ArtworkSource.Local({ path: "/media/poster.jpg" }));
      const flipped = `${key.slice(0, -2)}${key.at(-2) === "A" ? "B" : "A"}${key.at(-1) ?? ""}`;

      expect(yield* keys.open(flipped)).toStrictEqual(Option.none());
      expect(yield* other.open(key)).toStrictEqual(Option.none());
      expect(yield* keys.open("a1.short")).toStrictEqual(Option.none());
      expect(yield* keys.open("b1.whatever")).toStrictEqual(Option.none());
    }),
  );
});
