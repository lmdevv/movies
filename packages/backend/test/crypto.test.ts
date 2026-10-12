import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { base64UrlDecode, base64UrlEncode } from "../convex/lib/crypto";

describe("base64url in the Convex runtime helpers", () => {
  it("round-trips any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(base64UrlDecode(base64UrlEncode(bytes))).toStrictEqual(Uint8Array.from(bytes));
      }),
    );
  });

  it("accepts padding and rejects what is not base64url", () => {
    expect(base64UrlDecode("aGk=")).toStrictEqual(new TextEncoder().encode("hi"));

    for (const text of ["ab=", "abcde=", "a", "ab+c", "ab/c", "a b"]) {
      expect(base64UrlDecode(text), text).toBeNull();
    }
  });
});
