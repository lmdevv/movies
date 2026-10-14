import * as fc from "fast-check";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  TrickplayManifest,
  TrickplayVersion,
  trickplayLayout,
  trickplaySheetUrl,
  trickplayTile,
  trickplayVersion,
} from "./trickplay";

const decodeManifest = Schema.decodeUnknownSync(TrickplayManifest);

/** A two-hour film at 10 seconds: 720 thumbnails on eight 10 × 10 sheets. */
const film = decodeManifest({
  version: trickplayVersion(4_000_000_000, 1_760_000_000_000),
  intervalMs: 10_000,
  tileWidth: 320,
  tileHeight: 136,
  columns: 10,
  rows: 10,
  thumbnailCount: 720,
  sheetCount: 8,
});

const manifests = fc
  .record({
    intervalMs: fc.integer({ min: 1_000, max: 60_000 }),
    tileWidth: fc.integer({ min: 16, max: 640 }),
    tileHeight: fc.integer({ min: 9, max: 360 }),
    columns: fc.integer({ min: 1, max: 12 }),
    rows: fc.integer({ min: 1, max: 12 }),
    durationMs: fc.integer({ min: 0, max: 6 * 3_600_000 }),
  })
  .map(({ durationMs, ...layout }) =>
    decodeManifest({
      ...layout,
      version: "1-1",
      ...trickplayLayout(durationMs, layout.intervalMs, layout.columns * layout.rows),
    }),
  );

describe("trickplayTile", () => {
  it("finds the sheet and the tile of a position", () => {
    expect(trickplayTile(film, 0)).toEqual({
      sheet: 0,
      x: 0,
      y: 0,
      width: 320,
      height: 136,
      positionMs: 0,
    });

    // 1:23:45 is thumbnail 502: sheet 5, row 0, column 2.
    expect(trickplayTile(film, 5_025_000)).toEqual({
      sheet: 5,
      x: 640,
      y: 0,
      width: 320,
      height: 136,
      positionMs: 5_020_000,
    });

    // 9:59 is thumbnail 59: row 5, column 9.
    expect(trickplayTile(film, 599_999)).toMatchObject({ sheet: 0, x: 2880, y: 680 });
  });

  it("clamps positions outside the film to the first and last thumbnails", () => {
    expect(trickplayTile(film, -5_000)).toMatchObject({ sheet: 0, x: 0, y: 0, positionMs: 0 });
    expect(trickplayTile(film, 99_999_999)).toMatchObject({
      sheet: 7,
      x: 9 * 320,
      y: 1 * 136,
      positionMs: 7_190_000,
    });
    expect(trickplayTile(film, Number.NaN)).toMatchObject({ sheet: 0, positionMs: 0 });
  });

  it("always lands on an existing tile at or before the position", () => {
    fc.assert(
      fc.property(manifests, fc.integer({ min: 0, max: 8 * 3_600_000 }), (manifest, position) => {
        const tile = trickplayTile(manifest, position);

        const index =
          tile.sheet * manifest.columns * manifest.rows +
          (tile.y / manifest.tileHeight) * manifest.columns +
          tile.x / manifest.tileWidth;

        expect(tile.sheet).toBeLessThan(manifest.sheetCount);
        expect(tile.x + tile.width).toBeLessThanOrEqual(manifest.columns * manifest.tileWidth);
        expect(tile.y + tile.height).toBeLessThanOrEqual(manifest.rows * manifest.tileHeight);
        expect(index).toBe(tile.positionMs / manifest.intervalMs);
        expect(index).toBeLessThan(manifest.thumbnailCount);
        expect(tile.positionMs).toBeLessThanOrEqual(Math.max(0, position));
      }),
    );
  });
});

describe("trickplayLayout", () => {
  it("has one thumbnail per started interval and enough sheets for them", () => {
    expect(trickplayLayout(7_200_000, 10_000, 100)).toEqual({ thumbnailCount: 720, sheetCount: 8 });
    expect(trickplayLayout(7_201_000, 10_000, 100)).toEqual({ thumbnailCount: 721, sheetCount: 8 });
    expect(trickplayLayout(0, 10_000, 100)).toEqual({ thumbnailCount: 1, sheetCount: 1 });
  });
});

describe("trickplayVersion", () => {
  it("changes with the file's size or modification time and is a valid version", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 8_640_000_000_000 }),
        (size, mtime) => {
          const version = trickplayVersion(size, mtime);

          expect(Schema.is(TrickplayVersion)(version)).toBe(true);
          expect(trickplayVersion(size + 1, mtime)).not.toBe(version);
          expect(trickplayVersion(size, mtime + 1)).not.toBe(version);
        },
      ),
    );
  });
});

describe("trickplaySheetUrl", () => {
  it("names the file, version, and sheet and carries the token", () => {
    expect(trickplaySheetUrl("http://media.lan:4300/", "abc", film, 3, "v1.a+b")).toBe(
      `http://media.lan:4300/media/trickplay/abc/${film.version}/3.jpg?token=v1.a%2Bb`,
    );
  });
});
