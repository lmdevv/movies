import { Schema } from "effect";
import { assert, describe, it } from "vitest";

import { AgeRating, ageRatingFromCertification } from "./content-rating";

const age = Schema.decodeSync(AgeRating);

describe("ageRatingFromCertification", () => {
  it.each([
    ["G", 0],
    ["PG-13", 13],
    ["r", 17],
    ["TV-Y7", 7],
    ["TV-MA", 17],
    ["12A", 12],
    ["15", 15],
    ["FSK 16", 16],
    ["16+", 16],
    ["Rated PG-13", 13],
    ["Rated R", 17],
    ["US:PG-13", 13],
    ["us: R", 17],
    ["gb/15", 15],
    ["de/16", 16],
    ["DE:FSK 16", 16],
    ["R18+", 18],
    ["PG13", 13],
  ] as const)("maps %s to %i", (certification, expected) => {
    assert.strictEqual(ageRatingFromCertification(certification), age(expected));
  });

  it.each(["NR", "Unrated", "", "99", "Rated NR", "US:NR"])(
    "leaves %j unrated",
    (certification) => {
      assert.isUndefined(ageRatingFromCertification(certification));
    },
  );
});
