import { Schema } from "effect";
import { assert, describe, it } from "vitest";

import { AgeRating, ageRatingFromCertification, isAllowedForAge } from "./content-rating";

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
  ] as const)("maps %s to %i", (certification, expected) => {
    assert.strictEqual(ageRatingFromCertification(certification), age(expected));
  });

  it.each(["NR", "Unrated", "", "99"])("leaves %j unrated", (certification) => {
    assert.isUndefined(ageRatingFromCertification(certification));
  });
});

describe("isAllowedForAge", () => {
  it("shows everything to unrestricted profiles", () => {
    assert.isTrue(isAllowedForAge(undefined, undefined));
    assert.isTrue(isAllowedForAge(age(18), undefined));
  });

  it("hides unrated and older titles from restricted profiles", () => {
    assert.isFalse(isAllowedForAge(undefined, age(7)));
    assert.isFalse(isAllowedForAge(age(13), age(7)));
    assert.isTrue(isAllowedForAge(age(7), age(7)));
  });
});
