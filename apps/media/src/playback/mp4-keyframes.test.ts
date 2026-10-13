import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Option, Path } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { readMp4Keyframes } from "./mp4-keyframes.ts";

const hasFfmpeg = await ffmpegAvailable();

const toolsLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({})),
  Layer.provideMerge(NodeServices.layer),
);

/** Encodes ten seconds of video with `options`, keyframes at least every 1.5 s and at scene cuts. */
const encode = Effect.fn(function* (name: string, options: ReadonlyArray<string>) {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-mp4-" });
  const output = path.join(folder, name);

  yield* tools.ffmpeg(
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=25:duration=10",
      "-c:v",
      "libx264",
      "-g",
      "37",
      ...options,
      output,
    ],
    { timeout: Duration.minutes(1) },
  );

  return output;
});

/** Keyframe times as ffprobe's packet scan reports them. */
const scanned = Effect.fn(function* (file: string) {
  const tools = yield* MediaTools.Service;

  const csv = yield* tools.ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,flags",
    "-of",
    "csv=p=0",
    file,
  ]);

  return csv
    .split("\n")
    .map((line) => line.split(","))
    .filter(([time, flags]) => time !== undefined && (flags ?? "").startsWith("K"))
    .map(([time]) => Number(time))
    .toSorted((left, right) => left - right);
});

/** Keyframe times from the sample tables. */
const indexed = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file);

      return yield* readMp4Keyframes(
        (position, length) =>
          handle
            .readAlloc(length, { position: BigInt(position) })
            .pipe(Effect.map((bytes) => Option.getOrElse(bytes, () => new Uint8Array(0)))),
        Number(info.size),
      );
    }),
  );
});

describe.skipIf(!hasFfmpeg)("MP4 keyframe index", () => {
  layer(toolsLayer)((it) => {
    it.effect("matches a packet scan, with B-frames, edit lists, and moov at either end", () =>
      Effect.gen(function* () {
        const files = [
          // B-frames: composition offsets and an edit list that hides the first frame's delay.
          yield* encode("bframes.mp4", ["-preset", "veryfast", "-bf", "3"]),
          yield* encode("faststart.mp4", ["-preset", "veryfast", "-movflags", "+faststart"]),
          yield* encode("plain.mp4", ["-preset", "ultrafast"]),
          yield* encode("quicktime.mov", ["-preset", "veryfast"]),
        ];

        for (const file of files) {
          const expected = yield* scanned(file);
          const actual = yield* indexed(file);

          assert.isTrue(Option.isSome(actual), file);
          assert.strictEqual(Option.getOrThrow(actual).length, expected.length, file);

          for (const [index, time] of Option.getOrThrow(actual).entries()) {
            assert.approximately(time, expected[index] ?? Number.NaN, 0.002, file);
          }
        }
      }),
    );

    it.effect("leaves fragmented MP4 and files that are not MP4 to the packet scan", () =>
      Effect.gen(function* () {
        const fragmented = yield* encode("fragmented.mp4", [
          "-preset",
          "ultrafast",
          "-movflags",
          "+frag_keyframe+empty_moov",
        ]);

        const matroska = yield* encode("not-mp4.mkv", ["-preset", "ultrafast"]);

        assert.isTrue(Option.isNone(yield* indexed(fragmented)));
        assert.isTrue(Option.isNone(yield* indexed(matroska)));
      }),
    );
  });
});
