import { describe, expect, it } from "@effect/vitest";

import { fragmentSpan } from "./fmp4-fragments.ts";

const box = (type: string, body: ReadonlyArray<number>): Array<number> => {
  const size = 8 + body.length;

  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...new TextEncoder().encode(type),
    ...body,
  ];
};

const uint32 = (value: number): Array<number> => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const sidx = (
  version: 0 | 1,
  timescale: number,
  earliest: number,
  durations: ReadonlyArray<number>,
) =>
  box("sidx", [
    version,
    0,
    0,
    0,
    ...uint32(1),
    ...uint32(timescale),
    ...(version === 0
      ? [...uint32(earliest), ...uint32(0)]
      : [...uint32(0), ...uint32(earliest), ...uint32(0), ...uint32(0)]),
    0,
    0,
    0,
    durations.length,
    ...durations.flatMap((duration) => [...uint32(1000), ...uint32(duration), ...uint32(0)]),
  ]);

const styp = box("styp", [...new TextEncoder().encode("msdh")]);

describe("fragmentSpan", () => {
  it("reads the first sidx's start and adds the durations it references", () => {
    expect(
      fragmentSpan(
        new Uint8Array([...styp, ...sidx(0, 12_800, 13_867, [12_800]), ...sidx(0, 48_000, 0, [1])]),
      ),
    ).toEqual({ start: 13_867 / 12_800, end: (13_867 + 12_800) / 12_800 });
  });

  it("reads 64-bit times and several references", () => {
    expect(fragmentSpan(new Uint8Array([...styp, ...sidx(1, 1000, 2500, [500, 250])]))).toEqual({
      start: 2.5,
      end: 3.25,
    });
  });

  it("leaves the end unknown when the head cuts a sidx's references off", () => {
    expect(fragmentSpan(new Uint8Array(sidx(0, 1000, 2000, [1000]).slice(0, 40)))).toEqual({
      start: 2,
      end: undefined,
    });
  });

  it("finds no span before a moof, or without a sidx's times", () => {
    expect(fragmentSpan(new Uint8Array([...box("moof", []), ...sidx(0, 1000, 0, [1])]))).toBe(
      undefined,
    );
    expect(fragmentSpan(new Uint8Array(sidx(0, 1000, 0, [1000]).slice(0, 24)))).toBe(undefined);
  });
});
