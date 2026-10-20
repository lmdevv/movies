/**
 * Free space in `TRANSCODE_DIR`, shared by streams and download MP4s. A queued or running MP4 has
 * not written its bytes yet, so it reserves its estimate here until it finishes or stops; every
 * new stream or MP4 then needs `MIN_FREE_TRANSCODE_MB` beyond what the disk has left after those
 * reservations.
 */
import { InsufficientTranscodeSpace } from "@movies/contracts/media-playback";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";

import * as MediaConfig from "../media-config.ts";
import { errorCode, freeBytes } from "../platform/node-directories.ts";

/** Checks and reserves space in `TRANSCODE_DIR`. */
export interface Interface {
  /**
   * Fails with `InsufficientTranscodeSpace` unless the disk holds the configured minimum plus
   * every reservation plus `bytes`, then reserves `bytes` under `key` when it is given. An unknown
   * free space (the directory cannot be read) passes, as the write will fail anyway.
   */
  readonly claim: (bytes: number, key?: string) => Effect.Effect<void, InsufficientTranscodeSpace>;
  /** Drops the reservation under `key`, once its bytes are on disk or never will be. */
  readonly release: (key: string) => Effect.Effect<void>;
}

/** The transcode space ledger. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/TranscodeSpace",
) {}

/** The ledger over the configured `TRANSCODE_DIR`. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const reserved = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    // Checking and reserving happen together, so two claims never both count the same bytes.
    const lock = yield* Semaphore.make(1);

    const claim = Effect.fn("TranscodeSpace.claim")(function* (bytes: number, key?: string) {
      const available = yield* Effect.tryPromise(() => freeBytes(config.transcodeDir)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("TranscodeSpace.free_space_unknown").pipe(
            Effect.annotateLogs({ code: errorCode(error.cause) }),
          ),
        ),
        Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
      );

      const pending = [...(yield* Ref.get(reserved)).values()].reduce(
        (total, held) => total + held,
        0,
      );

      const required = config.minFreeTranscodeBytes + pending + bytes;

      if (available < required) {
        return yield* new InsufficientTranscodeSpace({
          freeBytes: available,
          requiredBytes: required,
        });
      }

      return yield* key === undefined
        ? Effect.void
        : Ref.update(reserved, (current) => new Map(current).set(key, bytes));
    }, lock.withPermits(1));

    const release = (key: string) =>
      Ref.update(reserved, (current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);

        return next;
      });

    return Service.of({ claim, release });
  }),
);
