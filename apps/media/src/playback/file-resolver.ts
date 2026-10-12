/**
 * Turns a file ID from a verified playback token into the file to stream. The integration
 * milestone implements `Service` over Convex; the media service never accepts a path from a
 * client. `resolveInsideRoots` re-checks every resolved path against the approved library roots
 * after following symbolic links, so a bad record cannot expose other files.
 */
import { type FileResolverUnavailable, MediaFileNotFound } from "@movies/contracts/media-playback";
import { Context, Effect, FileSystem, Option, Path, Schema } from "effect";

import type { MediaFileId } from "@movies/contracts/ids";
import { SidecarFormat } from "../library/sidecar-subtitles.ts";
import * as MediaConfig from "../media-config.ts";
import type { MediaProbe } from "../media/media-probe.ts";

/** A subtitle file beside the media file, with its absolute path. */
const ResolvedSidecar = Schema.Struct({
  path: Schema.String,
  format: SidecarFormat,
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  forced: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
  default: Schema.Boolean,
});

/** A subtitle file beside the media file, with its absolute path. */
interface ResolvedSidecar extends Schema.Schema.Type<typeof ResolvedSidecar> {}

/** Everything playback needs about one stored media file. */
export interface ResolvedMediaFile {
  readonly fileId: MediaFileId;
  /** Absolute path; `resolveInsideRoots` has checked it lies inside an approved library root. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly probe: MediaProbe;
  readonly subtitles: ReadonlyArray<ResolvedSidecar>;
}

/** Resolves stored file IDs. */
export interface Interface {
  readonly resolve: (
    fileId: MediaFileId,
  ) => Effect.Effect<ResolvedMediaFile, MediaFileNotFound | FileResolverUnavailable>;
}

/** The file resolver. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/FileResolver") {}

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

/**
 * The canonical path of `candidate` when, after following symbolic links, it lies inside an
 * approved library root (`LIBRARY_ROOTS`); none for a path outside them or one that does not
 * exist. Callers open the canonical path, so a link swapped after the check cannot redirect them.
 */
const realPathInsideApprovedRoots = Effect.fn("FileResolver.realPathInsideApprovedRoots")(
  function* (candidate: string) {
    const config = yield* MediaConfig.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const roots = (yield* Effect.forEach(config.libraryRoots, (root) =>
      fs.realPath(root).pipe(Effect.option),
    )).flatMap((root) => (Option.isSome(root) ? [root.value] : []));

    return yield* fs.realPath(candidate).pipe(
      Effect.map((real) =>
        roots.some((root) => isWithin(root, real, path.sep)) ? Option.some(real) : Option.none(),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  },
);

/**
 * Whether `candidate`, after following symbolic links, lies inside an approved library root
 * (`LIBRARY_ROOTS`). A path that does not exist is not inside.
 */
export const isInsideApprovedRoots = (candidate: string) =>
  Effect.map(realPathInsideApprovedRoots(candidate), Option.isSome);

/**
 * Resolves `fileId` and checks that the media file and its sidecars, after following symbolic
 * links, lie inside an approved library root. A file outside the roots is reported as not found
 * and logged; its path is never returned to the client.
 */
export const resolveInsideRoots = Effect.fn("FileResolver.resolveInsideRoots")(function* (
  fileId: MediaFileId,
) {
  const resolver = yield* Service;
  const file = yield* resolver.resolve(fileId);
  const real = yield* realPathInsideApprovedRoots(file.path);

  if (Option.isNone(real)) {
    yield* Effect.logError("FileResolver.path_rejected").pipe(Effect.annotateLogs({ fileId }));

    return yield* new MediaFileNotFound({ fileId });
  }

  const subtitles = yield* Effect.filter(file.subtitles, (subtitle) =>
    isInsideApprovedRoots(subtitle.path),
  );

  return { ...file, path: real.value, subtitles } satisfies ResolvedMediaFile;
});
