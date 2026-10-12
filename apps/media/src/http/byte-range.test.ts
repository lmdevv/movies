import { describe, expect, it } from "@effect/vitest";

import { ByteRange, parseByteRange } from "./byte-range.ts";

describe("parseByteRange", () => {
  it.each([
    [undefined, ByteRange.Full()],
    ["bytes=0-99", ByteRange.Partial({ start: 0, end: 99 })],
    ["bytes=100-", ByteRange.Partial({ start: 100, end: 999 })],
    ["bytes=-10", ByteRange.Partial({ start: 990, end: 999 })],
    ["bytes=-5000", ByteRange.Partial({ start: 0, end: 999 })],
    ["bytes=900-5000", ByteRange.Partial({ start: 900, end: 999 })],
    ["bytes=1000-", ByteRange.Unsatisfiable()],
    ["bytes=-0", ByteRange.Unsatisfiable()],
    ["bytes=50-10", ByteRange.Full()],
    ["bytes=0-1,5-9", ByteRange.Full()],
    ["items=0-9", ByteRange.Full()],
    ["bytes=-", ByteRange.Full()],
  ])("resolves %s against 1000 bytes", (header, expected) => {
    expect(parseByteRange(header, 1000)).toStrictEqual(expected);
  });

  it("finds no satisfiable suffix in an empty file", () => {
    expect(parseByteRange("bytes=-1", 0)).toStrictEqual(ByteRange.Unsatisfiable());
  });
});
