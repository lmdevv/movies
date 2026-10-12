/**
 * `FileResolver` over `mediaService:resolveFile`. A file's path must lie inside its library's
 * folders as Convex records them; `resolveInsideRoots` then re-checks the real path against the
 * approved `LIBRARY_ROOTS`. Size and modification time come from disk, which also proves the
 * file is still there. Answers are cached for thirty seconds, because a player asks for the same
 * file with every byte range and segment; failures are not cached.
 */
import type { MediaFileId } from "@movies/contracts/ids";
import { FileResolverUnavailable, MediaFileNotFound } from "@movies/contracts/media-playback";
import type { CallError } from "@movies/sdk/effect";
import { Cache, Duration, Effect, Exit, FileSystem, Layer, Match, Option } from "effect";

import * as FileResolver from "../playback/file-resolver.ts";
import { relativeTo, toResolvedMediaFile } from "./catalog-records.ts";
import * as MediaBackend from "./media-backend.ts";

const CACHE_TTL = Duration.seconds(30);

/** Builds the resolver. */
const make = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const fs = yield* FileSystem.FileSystem;

  const lookup = Effect.fn("ConvexFileResolver.lookup")(function* (fileId: MediaFileId) {
    const resolved = yield* backend.call("mediaService.resolveFile", { fileId }).pipe(
      Effect.mapError(
        Match.type<CallError>().pipe(
          Match.tags({
            NotFound: () => new MediaFileNotFound({ fileId }),
            InvalidArgs: () => new MediaFileNotFound({ fileId }),
          }),
          Match.orElse((error) => new FileResolverUnavailable({ cause: error })),
        ),
      ),
    );

    if (resolved.missing) return yield* new MediaFileNotFound({ fileId });

    const insideLibrary = resolved.roots.some((root) =>
      Option.isSome(relativeTo(root, resolved.path)),
    );

    if (!insideLibrary) {
      yield* Effect.logError("ConvexFileResolver.path_outside_library").pipe(
        Effect.annotateLogs({ fileId }),
      );

      return yield* new MediaFileNotFound({ fileId });
    }

    const info = yield* fs
      .stat(resolved.path)
      .pipe(Effect.mapError(() => new MediaFileNotFound({ fileId })));

    return toResolvedMediaFile(
      resolved,
      Number(info.size),
      Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
    );
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 1024,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : Duration.zero),
  });

  return FileResolver.Service.of({ resolve: (fileId) => Cache.get(cache, fileId) });
});

/** The resolver over the Convex connection. */
export const layer: Layer.Layer<
  FileResolver.Service,
  never,
  MediaBackend.Service | FileSystem.FileSystem
> = Layer.effect(FileResolver.Service, make);
