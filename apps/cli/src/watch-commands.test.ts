import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { TitleCard } from "@movies/contracts/models/catalog";

import { bestTitle } from "./watch-commands";

const card = (id: string, name: string) =>
  Schema.decodeSync(TitleCard)({
    id,
    kind: "movie",
    name,
    year: null,
    certification: null,
    ageRating: null,
    runtimeMs: null,
    genres: [],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: 0,
  });

describe("choosing what to play", () => {
  const results = [card("a", "Aliens"), card("b", "Alien"), card("c", "Alien: Romulus")];

  const chosen = (query: string, from = results) =>
    Option.getOrNull(Option.map(bestTitle(query, from), (title) => title.id));

  it("prefers an exact name, ignoring case and punctuation", () => {
    expect(chosen("ALIEN")).toBe("b");
    expect(chosen("alien romulus")).toBe("c");
  });

  it("falls back to a name starting with the query, then the first result", () => {
    expect(chosen("alien rom")).toBe("c");
    expect(chosen("xenomorph")).toBe("a");
    expect(chosen("anything", [])).toBeNull();
  });
});
