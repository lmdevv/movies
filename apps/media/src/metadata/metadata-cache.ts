/**
 * Best-effort disk cache for metadata provider responses under `DATA_DIR/metadata-cache`. Entries
 * hold the raw response text and its fetch time; callers parse what they read, as with any
 * other external input. Read and write failures are logged and treated as misses.
 */
import { createHash } from "node:crypto";

import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import * as MediaConfig from "../media-config.ts";

/** Cached provider responses. */
export interface Interface {
  /** The cached text for `key` when it is younger than `maxAge`. */
  readonly read: (
    namespace: string,
    key: string,
    maxAge: Duration.Duration,
  ) => Effect.Effect<Option.Option<string>>;
  readonly write: (namespace: string, key: string, body: string) => Effect.Effect<void>;
}

/** The metadata response cache. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MetadataCache") {}

const Entry = Schema.Struct({ fetchedAt: Schema.Finite, body: Schema.String });

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(Entry));

const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(Entry));

/** A cache rooted at `directory`. */
export const make = Effect.fn("MetadataCache.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileOf = (namespace: string, key: string): string =>
    path.join(directory, namespace, `${createHash("sha256").update(key).digest("hex")}.json`);

  const read = Effect.fn("MetadataCache.read")(function* (
    namespace: string,
    key: string,
    maxAge: Duration.Duration,
  ) {
    const file = fileOf(namespace, key);

    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
      return Option.none<string>();

    const entry = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeEntry),
      Effect.tapError((error) => Effect.logDebug("MetadataCache.unreadable", error)),
      Effect.option,
    );

    const now = yield* Clock.currentTimeMillis;

    return Option.filter(entry, (value) => now - value.fetchedAt < Duration.toMillis(maxAge)).pipe(
      Option.map((value) => value.body),
    );
  });

  const write = Effect.fn("MetadataCache.write")(function* (
    namespace: string,
    key: string,
    body: string,
  ) {
    const file = fileOf(namespace, key);
    const temporary = `${file}.${(yield* Clock.currentTimeNanos).toString(36)}.part`;
    const fetchedAt = yield* Clock.currentTimeMillis;

    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(temporary, yield* encodeEntry({ fetchedAt, body }));
      yield* fs.rename(temporary, file);
    }).pipe(
      Effect.tapError((error) => Effect.logWarning("MetadataCache.write_failed", error)),
      Effect.ignore,
    );
  });

  return Service.of({ read, write });
});

/** A cache under `DATA_DIR/metadata-cache`. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const path = yield* Path.Path;

    return yield* make(path.join(config.dataDir, "metadata-cache"));
  }),
);
