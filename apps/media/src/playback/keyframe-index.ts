/**
 * Video keyframe times for copy-mode HLS, where segments can only start on source keyframes.
 * Matroska files answer from their Cues index in a few reads; other files fall back to an
 * ffprobe packet scan, which reads the whole file. Results are cached on disk by file ID, size,
 * and modification time, so each file pays the cost once.
 */
import { Context, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "./file-resolver.ts";
import { readMatroskaKeyframes } from "./matroska-cues.ts";

/** Neither the container index nor a packet scan produced keyframes. */
export class KeyframeIndexFailed extends Schema.TaggedError<KeyframeIndexFailed>()(
  "KeyframeIndexFailed",
  {
    fileId: Schema.String,
    cause: Schema.Defect(),
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Keyframe index failed for file ${this.fileId}`;
  }
}

/** Keyframe times of media files. */
export interface Interface {
  /** Video keyframe times in seconds on the file's own timeline, ascending. */
  readonly keyframes: (
    file: ResolvedMediaFile,
  ) => Effect.Effect<ReadonlyArray<number>, KeyframeIndexFailed>;
}

/** The keyframe index. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/KeyframeIndex") {}

const CACHE_NAMESPACE = "keyframes";

const CACHE_MAX_AGE = Duration.days(3650);

const Keyframes = Schema.fromJsonString(Schema.Array(Schema.Finite));

const decodeKeyframes = Schema.decodeEffect(Keyframes);

const encodeKeyframes = Schema.encodeEffect(Keyframes);

/** Parses ffprobe `packet=pts_time,flags` CSV lines, keeping keyframes. */
const parsePacketList = (csv: string): ReadonlyArray<number> =>
  csv
    .split("\n")
    .map((line) => line.trim().split(","))
    .filter(
      ([time, flags]) => time !== undefined && time !== "N/A" && (flags ?? "").startsWith("K"),
    )
    .map(([time]) => Number(time))
    .filter(Number.isFinite)
    .toSorted((left, right) => left - right);

/** Builds the keyframe index. */
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const cache = yield* DiskCache.Service;

  const fromMatroska = (path: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path);

        return yield* readMatroskaKeyframes((position, length) =>
          file
            .readAlloc(length, { position: BigInt(position) })
            .pipe(Effect.map((bytes) => Option.getOrElse(bytes, () => new Uint8Array(0)))),
        );
      }),
    );

  const fromPacketScan = Effect.fn("KeyframeIndex.packetScan")(function* (path: string) {
    const csv = yield* tools.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      path,
    ]);

    return parsePacketList(csv);
  });

  const keyframes = Effect.fn("KeyframeIndex.keyframes")(function* (file: ResolvedMediaFile) {
    const key = `${file.fileId}:${file.sizeBytes}:${file.modifiedAtMs}`;
    const cached = yield* cache.read(CACHE_NAMESPACE, key, CACHE_MAX_AGE);

    if (Option.isSome(cached)) {
      const decoded = yield* decodeKeyframes(cached.value).pipe(Effect.option);

      if (Option.isSome(decoded) && decoded.value.length > 0) return decoded.value;
    }

    const failed = (cause: unknown) => new KeyframeIndexFailed({ fileId: file.fileId, cause });

    const indexed =
      file.probe.container === "mkv" || file.probe.container === "webm"
        ? yield* fromMatroska(file.path).pipe(
            Effect.tapError((error) => Effect.logDebug("KeyframeIndex.cues_unreadable", error)),
            Effect.orElseSucceed(() => Option.none<ReadonlyArray<number>>()),
          )
        : Option.none<ReadonlyArray<number>>();

    const times = Option.isSome(indexed)
      ? indexed.value
      : yield* fromPacketScan(file.path).pipe(Effect.mapError(failed));

    if (times.length === 0) return yield* failed("no keyframes");
    yield* cache.write(CACHE_NAMESPACE, key, yield* encodeKeyframes(times).pipe(Effect.orDie));

    return times;
  });

  return Service.of({ keyframes });
});

/** The keyframe index over the platform file system, ffprobe, and the disk cache. */
export const layer: Layer.Layer<
  Service,
  never,
  FileSystem.FileSystem | MediaTools.Service | DiskCache.Service
> = Layer.effect(Service, make);
