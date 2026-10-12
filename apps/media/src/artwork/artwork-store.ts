/**
 * Artwork images behind artwork keys. A local image is read from its library folder after the
 * same approved-roots check playback uses; a provider image is downloaded once from an allowed
 * host into `DATA_DIR/artwork/originals`. Resized copies (one of `ARTWORK_WIDTHS`, JPEG) are made
 * with ffmpeg on first request and kept in `DATA_DIR/artwork/w<width>`, keyed by the source and,
 * for local files, its size and modification time, so a replaced poster gets a fresh copy.
 */
import { createHash } from "node:crypto";

import type { ArtworkWidth } from "@movies/contracts/artwork";
import {
  Cache,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { isInsideApprovedRoots } from "../playback/file-resolver.ts";
import * as ArtworkKeys from "./artwork-keys.ts";
import { ArtworkSource } from "./artwork-keys.ts";

/** An image file ready to serve. */
export interface ArtworkImage {
  readonly path: string;
  readonly contentType: string;
}

/** No image behind this key: unknown, outside the libraries, or gone from disk. */
export class ArtworkNotFound extends Schema.TaggedError<ArtworkNotFound>()("ArtworkNotFound", {}) {
  override get message(): string {
    return "Artwork not found";
  }
}

/** The image exists but could not be fetched or resized right now. */
export class ArtworkUnavailable extends Schema.TaggedError<ArtworkUnavailable>()(
  "ArtworkUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Artwork unavailable: the image could not be fetched or resized";
  }
}

/** Serves artwork images. */
export interface Interface {
  /** The image behind `key`, resized to `width` when given. */
  readonly image: (
    key: string,
    width: Option.Option<ArtworkWidth>,
  ) => Effect.Effect<ArtworkImage, ArtworkNotFound | ArtworkUnavailable>;
}

/** The artwork store. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/ArtworkStore") {}

/** Hosts provider images may come from. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["image.tmdb.org"]);

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["tbn", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const contentTypeOf = (path: string): string =>
  CONTENT_TYPES.get(path.split(".").at(-1)?.toLowerCase() ?? "") ?? "application/octet-stream";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Builds the store. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const keys = yield* ArtworkKeys.Service;
  const tools = yield* MediaTools.Service;
  const http = yield* HttpClient.HttpClient;
  const directory = path.join(config.dataDir, "artwork");

  const provide = <A, E>(
    effect: Effect.Effect<A, E, MediaConfig.Service | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  /** Writes `bytes` to `target` through a temporary file, so readers never see a partial file. */
  const writeAtomically = Effect.fnUntraced(function* (target: string, bytes: Uint8Array) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part`;
    yield* fs.writeFile(temporary, bytes);
    yield* fs.rename(temporary, target);
  });

  const download = Effect.fn("ArtworkStore.download")(function* (url: string) {
    const host = Option.liftThrowable(() => new URL(url).host)();

    if (Option.isNone(host) || !ALLOWED_HOSTS.has(host.value)) {
      return yield* new ArtworkNotFound();
    }

    const extension = url.split(".").at(-1)?.toLowerCase() ?? "jpg";
    const target = path.join(directory, "originals", `${hash(url)}.${extension}`);

    if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) return target;

    const bytes = yield* http.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.mapError((cause) => new ArtworkUnavailable({ cause })),
    );

    yield* writeAtomically(target, new Uint8Array(bytes)).pipe(
      Effect.mapError((cause) => new ArtworkUnavailable({ cause })),
    );

    return target;
  });

  /** The original image file and a fingerprint that changes when its content does. */
  const original = Effect.fn("ArtworkStore.original")(function* (source: ArtworkSource) {
    return yield* ArtworkSource.$match(source, {
      Local: ({ path: file }) =>
        Effect.gen(function* () {
          if (!(yield* provide(isInsideApprovedRoots(file)))) return yield* new ArtworkNotFound();

          const info = yield* fs.stat(file).pipe(Effect.mapError(() => new ArtworkNotFound()));

          const modified = Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          });

          return { file, fingerprint: `${file}\u0000${String(info.size)}\u0000${modified}` };
        }),
      Remote: ({ url }) => download(url).pipe(Effect.map((file) => ({ file, fingerprint: url }))),
    });
  });

  const resize = Effect.fn("ArtworkStore.resize")(function* (
    file: string,
    fingerprint: string,
    width: ArtworkWidth,
  ) {
    const target = path.join(directory, `w${String(width)}`, `${hash(fingerprint)}.jpg`);

    if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) return target;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orDie);
    const temporary = `${target}.${(yield* Clock.currentTimeNanos).toString(36)}.part.jpg`;

    yield* tools
      .ffmpeg([
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-vf",
        `scale='min(${String(width)},iw)':-2`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        temporary,
      ])
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));

    yield* fs
      .rename(temporary, target)
      .pipe(Effect.mapError((cause) => new ArtworkUnavailable({ cause })));

    return target;
  });

  // Concurrent requests for the same image share one download or resize.
  const images = yield* Cache.makeWith(
    ([key, width]: readonly [string, Option.Option<ArtworkWidth>]) =>
      Effect.gen(function* () {
        const source = yield* keys.open(key);

        if (Option.isNone(source)) return yield* new ArtworkNotFound();
        const { file, fingerprint } = yield* original(source.value);

        if (Option.isNone(width)) return { path: file, contentType: contentTypeOf(file) };

        return { path: yield* resize(file, fingerprint, width.value), contentType: "image/jpeg" };
      }),
    {
      capacity: 2048,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero),
    },
  );

  return Service.of({
    image: (key, width) => Cache.get(images, [key, width] as const),
  });
});

/** The store under `DATA_DIR/artwork`. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | ArtworkKeys.Service
  | MediaTools.Service
  | HttpClient.HttpClient
> = Layer.effect(Service, make);
