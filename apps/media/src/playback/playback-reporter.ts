/**
 * Playback events the media service reports outward: the mode each per-device session started
 * in, mode changes such as a QSV failure falling back to software, and stream endings. The
 * integration milestone forwards them to Convex; standalone mode logs them, and tests record them.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect";

import { FileId, PlaybackSessionId, StreamId } from "../ids.ts";
import { PlaybackMode } from "./playback-decision.ts";

/** Something that happened to a per-device playback session. */
export const PlaybackEvent = Schema.TaggedUnion({
  /** Negotiation chose a mode. HLS sessions carry their stream ID. */
  ModeChosen: {
    sessionId: PlaybackSessionId,
    fileId: FileId,
    streamId: Schema.optional(StreamId),
    mode: PlaybackMode,
  },
  /** A running session switched modes, for example from QSV to software. */
  ModeChanged: {
    sessionId: PlaybackSessionId,
    fileId: FileId,
    streamId: StreamId,
    from: PlaybackMode,
    to: PlaybackMode,
    reason: Schema.Literals(["hardware-unavailable"]),
  },
  /** An HLS session closed and its temporary segments were deleted. */
  StreamEnded: {
    sessionId: PlaybackSessionId,
    fileId: FileId,
    streamId: StreamId,
    reason: Schema.Literals(["stopped", "idle", "replaced", "failed", "shutdown"]),
  },
});

/** Something that happened to a per-device playback session. */
export type PlaybackEvent = typeof PlaybackEvent.Type;

/** Receives playback events. Reporting never fails playback. */
export interface Interface {
  readonly report: (event: PlaybackEvent) => Effect.Effect<void>;
}

/** The playback event reporter. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/PlaybackReporter",
) {}

/** Logs events; used until the Convex integration forwards them. */
export const layerLog: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    report: (event) => Effect.logInfo("PlaybackReporter.event", event),
  }),
);

/** Inspection of a recording reporter. */
export interface RecordingInterface {
  readonly events: Effect.Effect<ReadonlyArray<PlaybackEvent>>;
}

/** A reporter that keeps every event in memory, for tests. */
export class Recording extends Context.Service<Recording, RecordingInterface>()(
  "@movies/media/PlaybackReporter/Recording",
) {}

/** A recording reporter providing both the reporter and its inspection service. */
export const layerRecording: Layer.Layer<Service | Recording> = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<PlaybackEvent>>([]);

    return Context.empty().pipe(
      Context.add(
        Service,
        Service.of({ report: (event) => Ref.update(events, (seen) => [...seen, event]) }),
      ),
      Context.add(Recording, Recording.of({ events: Ref.get(events) })),
    );
  }),
);
