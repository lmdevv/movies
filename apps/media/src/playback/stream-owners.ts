/**
 * Which playback session each HLS stream belongs to, while it is open and for ten minutes after it
 * ends, since a player's last reports about a stream arrive after it closed. `StreamSessions`
 * records every stream it opens and closes; a player's diagnostic events are checked against it,
 * so a report cannot file its events under another session's stream.
 */
import type { PlaybackSessionId } from "@movies/contracts/ids";
import type { StreamId } from "@movies/contracts/media-playback";
import { Clock, Context, Effect, Layer } from "effect";

/** Stream owners. */
export interface Interface {
  /** Records that `streamId` plays for `sessionId`. */
  readonly opened: (streamId: StreamId, sessionId: PlaybackSessionId) => Effect.Effect<void>;
  /** Records that `streamId` ended; it still belongs to its session for a while. */
  readonly closed: (streamId: StreamId) => Effect.Effect<void>;
  /** Whether `streamId` is open, or ended a short while ago, for `sessionId`. */
  readonly belongsTo: (streamId: string, sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
}

/** The stream owner registry. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/StreamOwners") {}

/** How long an ended stream keeps its owner: as long as a player's event may be late. */
const ENDED_GRACE_MS = 10 * 60 * 1000;

/** Ended streams remembered at most; beyond this the oldest are forgotten early. */
const MAX_ENDED = 10_000;

interface Owner {
  readonly sessionId: PlaybackSessionId;
  /** When the stream ended; undefined while it is open. */
  readonly endedAt: number | undefined;
}

const make = Effect.sync((): Interface => {
  // Ended streams are kept in the order they ended, so the oldest come first.
  const owners = new Map<string, Owner>();
  let ended = 0;

  const forgetEnded = (now: number): void => {
    for (const [streamId, owner] of owners) {
      if (owner.endedAt === undefined) continue;

      if (now - owner.endedAt < ENDED_GRACE_MS && ended <= MAX_ENDED) return;
      owners.delete(streamId);
      ended -= 1;
    }
  };

  return {
    opened: (streamId, sessionId) =>
      Effect.sync(() => {
        owners.set(streamId, { sessionId, endedAt: undefined });
      }),
    closed: (streamId) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const owner = owners.get(streamId);

        if (owner === undefined || owner.endedAt !== undefined) return;
        owners.delete(streamId);
        owners.set(streamId, { sessionId: owner.sessionId, endedAt: now });
        ended += 1;
        forgetEnded(now);
      }),
    belongsTo: (streamId, sessionId) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        forgetEnded(now);

        return owners.get(streamId)?.sessionId === sessionId;
      }),
  };
});

/** An empty registry. */
export const layer: Layer.Layer<Service> = Layer.effect(Service, make);
