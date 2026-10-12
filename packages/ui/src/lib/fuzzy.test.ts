import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore } from "./fuzzy";

const isSubsequence = (needle: string, haystack: string): boolean => {
  let from = 0;

  for (const char of needle) {
    const index = haystack.indexOf(char, from);

    if (index === -1) return false;

    from = index + 1;
  }

  return true;
};

const word = fc.stringMatching(/^[a-z]{1,8}$/);

describe("fuzzyScore", () => {
  it("matches everything with an empty query", () => {
    fc.assert(fc.property(fc.string(), (text) => fuzzyScore("", text) === 0));
    expect(fuzzyScore("   ", "Dune")).toBe(0);
  });

  it("matches exactly when every term is an in-order subsequence of the text", () => {
    fc.assert(
      fc.property(word, fc.array(word, { maxLength: 4 }), (query, words) => {
        const text = words.join(" ");

        expect(fuzzyScore(query, text) !== null).toBe(isSubsequence(query, text));
      }),
    );
  });

  it("finds every substring of the text", () => {
    fc.assert(
      fc.property(
        fc.array(word, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.nat(),
        (words, a, b) => {
          const text = words.join(" ");
          const start = a % text.length;
          const end = start + 1 + (b % (text.length - start));
          const score = fuzzyScore(text.slice(start, end).trim(), text);

          expect(score).not.toBeNull();
        },
      ),
    );
  });

  it("ignores case and diacritics", () => {
    expect(fuzzyScore("shogun", "Shōgun")).not.toBeNull();
    expect(fuzzyScore("ESPANOL", "Español")).not.toBeNull();
  });

  it("requires every term to match", () => {
    expect(fuzzyScore("sev s2", "Severance S2:E4")).not.toBeNull();
    expect(fuzzyScore("sev s9", "Severance S2:E4")).toBeNull();
  });

  it("ranks a prefix above a word start above a scattered match", () => {
    const prefix = fuzzyScore("sev", "Severance") ?? 0;
    const wordStart = fuzzyScore("sev", "The Severance") ?? 0;
    const inner = fuzzyScore("sev", "Unseverable") ?? 0;
    const scattered = fuzzyScore("sev", "Sam Evans Vault") ?? 0;

    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { title: "Seven Samurai", detail: "Movie · 1954" },
    { title: "Severance", detail: "Show · 2022" },
    { title: "Settings", detail: "" },
    { title: "Dune: Part Two", detail: "1h 03m left" },
  ] as const;

  const texts = (item: (typeof items)[number]): ReadonlyArray<string> => [item.title, item.detail];

  it("returns every item in order for an empty query", () => {
    expect(fuzzyFilter(items, "", texts)).toEqual(items);
  });

  it("drops non-matches and puts the best title match first", () => {
    const result = fuzzyFilter(items, "sever", texts).map((item) => item.title);

    expect(result).toEqual(["Severance", "Seven Samurai"]);
  });

  it("matches across title and detail together", () => {
    const result = fuzzyFilter(items, "seven 1954", texts).map((item) => item.title);

    expect(result).toEqual(["Seven Samurai"]);
  });

  it("keeps the original order for equal scores", () => {
    fc.assert(
      fc.property(fc.array(word, { maxLength: 10 }), (titles) => {
        const same = titles.map((title) => ({ title: "same", detail: title }));
        const result = fuzzyFilter(same, "same", (item) => [item.title, item.detail]);

        expect(result).toEqual(same);
      }),
    );
  });
});
