/**
 * Per-device HLS stream sessions and the ffmpeg runs behind them.
 *
 * A session belongs to one playback session (`sid`) and file. Each ffmpeg run is a numbered
 * generation in its own scope and folder. ffmpeg writes one fMP4 fragment per keyframe interval;
 * the session groups fragments into the planned segments by their `sidx` start times. A request
 * outside the produced range starts a new generation at the requested segment and answers the
 * old generation with `StreamGenerationGone`, so output from two runs is never mixed. Closing a
 * generation's scope kills its ffmpeg and deletes its folder; sessions close on stop, on
 * replacement by a newer session for the same device, after `STREAM_IDLE_SECONDS` without
 * requests, on failure, and at shutdown. Stream IDs live only in memory, so a restarted service
 * answers old IDs with `StreamNotFound` and clients renegotiate.
 */
import {
  type ClientCapabilities,
  InsufficientTranscodeSpace,
  type KeyframeIndexFailed,
  SegmentNotFound,
  SegmentNotReady,
  StreamAccessDenied,
  StreamGenerationGone,
  StreamNotFound,
  TranscodeCapacityReached,
  TranscodeFailed,
  UnsupportedPlayback,
} from "@movies/contracts/media-playback";
import type { PlaybackMode } from "@movies/contracts/models/playback";
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Scope,
  Semaphore,
} from "effect";

import type { MediaFileId, PlaybackSessionId } from "@movies/contracts/ids";
import { StreamId } from "@movies/contracts/media-playback";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { errorCode, freeBytes } from "../platform/node-directories.ts";
import type { ResolvedMediaFile } from "./file-resolver.ts";
import { FRAGMENT_HEAD_BYTES, fragmentStartSeconds } from "./fmp4-fragments.ts";
import * as HardwareAcceleration from "./hardware-acceleration.ts";
import { planGridSegments, planKeyframeSegments, type SegmentPlan, segmentAt } from "./hls-plan.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { type AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import type { PlaybackGrant } from "./playback-token.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

/** What negotiation hands to a new session. */
interface StartRequest {
  readonly grant: PlaybackGrant;
  readonly file: ResolvedMediaFile;
  readonly plan: Extract<PlaybackPlan, { readonly _tag: "Hls" }>;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly startSeconds: number;
}

/** A started stream. `mode` reflects any fallback that happened while starting. */
interface StartedStream {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly mode: Exclude<PlaybackMode, "direct">;
  readonly segmentIndex: number;
}

/** The current generation and plan of a stream, for rendering its playlist. */
interface StreamView {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly plan: SegmentPlan;
}

/** Files that make up one served part, in order. */
interface SegmentFiles {
  readonly paths: ReadonlyArray<string>;
  readonly sizeBytes: number;
}

/** Failures of requests against an existing stream. */
type StreamRequestError =
  | StreamNotFound
  | StreamAccessDenied
  | StreamGenerationGone
  | SegmentNotFound
  | SegmentNotReady
  | TranscodeFailed
  | UnsupportedPlayback;

/** Failures of starting a stream. */
export type StartError =
  | TranscodeCapacityReached
  | InsufficientTranscodeSpace
  | UnsupportedPlayback
  | TranscodeFailed
  | KeyframeIndexFailed;

/** HLS stream sessions. */
export interface Interface {
  readonly start: (request: StartRequest) => Effect.Effect<StartedStream, StartError>;
  readonly playlist: (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<StreamView, StreamRequestError>;
  readonly init: (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<SegmentFiles, StreamRequestError>;
  readonly segment: (
    streamId: StreamId,
    generation: number,
    index: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<SegmentFiles, StreamRequestError>;
  /** Moves playback to `seconds`, starting a new generation unless that point is already produced. */
  readonly seek: (
    streamId: StreamId,
    seconds: number,
    grant: PlaybackGrant,
  ) => Effect.Effect<StreamView, StreamRequestError>;
  readonly stop: (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) => Effect.Effect<void, StreamNotFound | StreamAccessDenied>;
  /**
   * Closes every stream of a playback session that ended elsewhere, such as a sign-out or a newer
   * session on the same device. Returns how many streams it closed.
   */
  readonly endSession: (sessionId: PlaybackSessionId) => Effect.Effect<number>;
  /** Number of open sessions. */
  readonly activeCount: Effect.Effect<number>;
}

/** The stream session manager. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/StreamSessions",
) {}

/** Segments past the produced range that a request may still wait for instead of seeking. */
const LOOKAHEAD_SEGMENTS = 3;

/** Tolerance when comparing fragment start times with planned boundaries. */
const TIME_EPSILON = 0.005;

const POLL_INTERVAL = Duration.millis(100);

const SEGMENT_WAIT = Duration.seconds(30);

const START_WAIT = Duration.seconds(20);

interface Fragment {
  readonly path: string;
  readonly start: number;
  readonly sizeBytes: number;
}

interface Generation {
  readonly number: number;
  readonly startSegment: number;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly exit: Deferred.Deferred<void, MediaTools.MediaToolFailed>;
  readonly fragments: Ref.Ref<ReadonlyArray<Fragment>>;
}

interface Session {
  readonly streamId: StreamId;
  readonly sessionId: PlaybackSessionId;
  readonly fileId: MediaFileId;
  readonly file: ResolvedMediaFile;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly plan: SegmentPlan;
  readonly scope: Scope.Closeable;
  readonly mode: Ref.Ref<Exclude<PlaybackMode, "direct">>;
  readonly video: Ref.Ref<VideoPlan>;
  readonly audio: AudioPlan;
  readonly generation: Ref.Ref<Generation>;
  readonly lock: Semaphore.Semaphore;
  readonly lastActivity: Ref.Ref<number>;
}

/** The produced range of a generation, in planned segment indexes. */
interface Produced {
  readonly members: ReadonlyMap<number, ReadonlyArray<Fragment>>;
  /** Highest segment with at least one fragment; `startSegment - 1` when none. */
  readonly head: number;
}

const isEncode = VideoPlan.$is("Encode");

/** Builds the session manager. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tools = yield* MediaTools.Service;
  const keyframes = yield* KeyframeIndex.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const sessions = yield* Ref.make<ReadonlyMap<StreamId, Session>>(new Map());
  const transcodes = yield* Ref.make(0);
  const registry = yield* Semaphore.make(1);

  // Leftovers of a previous process are never served again.
  yield* fs.makeDirectory(config.transcodeDir, { recursive: true }).pipe(Effect.orDie);

  for (const name of yield* fs
    .readDirectory(config.transcodeDir)
    .pipe(Effect.orElseSucceed(() => []))) {
    yield* fs.remove(path.join(config.transcodeDir, name), { recursive: true }).pipe(Effect.ignore);
  }

  const newStreamId = crypto.randomBytes(16).pipe(
    Effect.map((bytes) => StreamId.make(Buffer.from(bytes).toString("base64url"))),
    Effect.orDie,
  );

  const touch = (session: Session) =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(session.lastActivity, now)));

  const closeSession = Effect.fn("StreamSessions.close")(function* (
    session: Session,
    reason: PlaybackReporter.StreamEndReason,
  ) {
    const removed = yield* Ref.modify(sessions, (current) => {
      if (current.get(session.streamId) !== session) return [false, current] as const;
      const next = new Map(current);
      next.delete(session.streamId);

      return [true, next] as const;
    });

    yield* Scope.close(session.scope, Exit.void);

    if (removed) {
      yield* reporter.report(
        PlaybackReporter.PlaybackEvent.cases.StreamEnded.make({
          sessionId: session.sessionId,
          fileId: session.fileId,
          streamId: session.streamId,
          reason,
        }),
      );
    }
  });

  /** Indexes fragment files ffmpeg finished since the last look. */
  const refreshFragments = Effect.fnUntraced(function* (generation: Generation) {
    const known = new Set((yield* Ref.get(generation.fragments)).map((fragment) => fragment.path));

    const names = yield* fs
      .readDirectory(generation.directory)
      .pipe(Effect.orElseSucceed(() => []));

    const fresh = yield* Effect.forEach(
      names
        .filter((name) => /^f\d+\.m4s$/.test(name))
        .map((name) => path.join(generation.directory, name)),
      (file) =>
        known.has(file)
          ? Effect.succeedNone
          : Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* fs.open(file);
                const head = yield* handle.readAlloc(FRAGMENT_HEAD_BYTES, { position: 0n });
                const info = yield* handle.stat;

                const start = Option.flatMap(head, (bytes) =>
                  Option.fromNullishOr(fragmentStartSeconds(bytes)),
                );

                return Option.map(start, (seconds): Fragment => ({
                  path: file,
                  start: seconds,
                  sizeBytes: Number(info.size),
                }));
              }),
            ).pipe(Effect.orElseSucceed(() => Option.none<Fragment>())),
    );

    const added = fresh.flatMap((fragment) => (Option.isSome(fragment) ? [fragment.value] : []));

    if (added.length > 0) {
      yield* Ref.update(generation.fragments, (current) =>
        [...current, ...added].toSorted((left, right) => left.start - right.start),
      );
    }
  });

  const producedRange = (
    session: Session,
    generation: Generation,
    fragments: ReadonlyArray<Fragment>,
  ): Produced => {
    const members = new Map<number, Array<Fragment>>();

    for (const fragment of fragments) {
      const index = Math.max(
        generation.startSegment,
        segmentAt(session.plan, fragment.start + TIME_EPSILON),
      );

      members.set(index, [...(members.get(index) ?? []), fragment]);
    }

    return { members, head: Math.max(generation.startSegment - 1, ...members.keys()) };
  };

  const startGeneration = Effect.fn("StreamSessions.startGeneration")(function* (
    session: Session,
    number: number,
    startSegment: number,
  ) {
    const directory = path.join(config.transcodeDir, session.streamId, String(number));
    const scope = yield* Scope.fork(session.scope, "sequential");

    yield* Scope.addFinalizer(scope, fs.remove(directory, { recursive: true }).pipe(Effect.ignore));
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
    const video = session.file.probe.video;
    const from = session.plan.starts[startSegment] ?? session.plan.end;
    const videoPlan = yield* Ref.get(session.video);

    const args = hlsCommandArgs({
      input: session.file.path,
      sourceStart: session.file.probe.startSeconds,
      from,
      videoIndex: video?.index ?? 0,
      videoCodec: video?.codec ?? "",
      videoBitDepth: video?.bitDepth ?? 8,
      video: videoPlan,
      audio: session.audio,
      segmentStarts: session.plan.starts.slice(startSegment),
      outputDirectory: directory,
      qsvDevice: hardware.qsvDevice,
    });

    const exit = yield* Deferred.make<void, MediaTools.MediaToolFailed>();

    const running = yield* tools.startFfmpeg(args).pipe(
      Scope.provide(scope),
      Effect.catch((error) => Deferred.fail(exit, error).pipe(Effect.as(undefined))),
    );

    if (running !== undefined) {
      yield* running.exit.pipe(
        Effect.exit,
        Effect.flatMap((result) => Deferred.done(exit, result)),
        Effect.forkIn(scope),
      );
    }

    const generation: Generation = {
      number,
      startSegment,
      directory,
      scope,
      exit,
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
    };

    const previous = yield* Ref.getAndSet(session.generation, generation);

    if (previous.number !== number) yield* Scope.close(previous.scope, Exit.void);

    return generation;
  });

  /**
   * After a QSV failure, switches the session to software when the ladder allows it, reports the
   * mode change, and returns the new mode; otherwise fails with the ladder's reason.
   */
  const fallBackToSoftware = Effect.fn("StreamSessions.fallBackToSoftware")(function* (
    session: Session,
    detail: string,
  ) {
    yield* hardware.markQsvUnavailable(detail);

    const plan = decidePlayback(session.file.probe, session.client, {
      audioIndex: session.audioIndex,
      hardwareTranscoding: false,
    });

    if (!PlaybackPlan.$is("Hls")(plan)) {
      return yield* new UnsupportedPlayback({
        reason: PlaybackPlan.$is("Unsupported")(plan)
          ? plan.reason
          : "hdr-tone-mapping-requires-hardware",
      });
    }

    const from = yield* Ref.getAndSet(session.mode, plan.mode);
    yield* Ref.set(session.video, plan.video);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChanged.make({
        sessionId: session.sessionId,
        fileId: session.fileId,
        streamId: session.streamId,
        from,
        to: plan.mode,
        reason: "hardware-unavailable",
      }),
    );

    return plan.mode;
  });

  /**
   * Waits until segment `index` of `generation` is complete. A failed QSV run falls back to
   * software and starts a new generation, reported as `StreamGenerationGone`.
   */
  const awaitSegment = Effect.fn("StreamSessions.awaitSegment")(function* (
    session: Session,
    generation: Generation,
    index: number,
    maxWait: Duration.Duration,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(maxWait);

    for (;;) {
      const current = yield* Ref.get(session.generation);

      // A seek replaced this generation while the request waited; its output is gone.
      if (current.number !== generation.number) {
        return yield* new StreamGenerationGone({
          streamId: session.streamId,
          generation: generation.number,
          currentGeneration: current.number,
        });
      }

      const finished = yield* Deferred.isDone(generation.exit);
      yield* refreshFragments(generation);
      const fragments = yield* Ref.get(generation.fragments);
      const produced = producedRange(session, generation, fragments);
      const next = session.plan.starts[index + 1];

      const pastEnd =
        next !== undefined && fragments.some((fragment) => fragment.start + TIME_EPSILON >= next);

      if (finished) {
        const result = yield* Deferred.await(generation.exit).pipe(Effect.exit);

        if (Exit.isFailure(result) && !pastEnd) {
          const mode = yield* Ref.get(session.mode);

          const detail = Exit.match(result, {
            onSuccess: () => "",
            onFailure: (cause) => String(cause),
          }).slice(-300);

          if (mode !== "transcode-qsv") {
            return yield* new TranscodeFailed({ streamId: session.streamId, mode, detail });
          }

          yield* fallBackToSoftware(session, detail);
          const restarted = yield* startGeneration(session, generation.number + 1, index);

          return yield* new StreamGenerationGone({
            streamId: session.streamId,
            generation: generation.number,
            currentGeneration: restarted.number,
          });
        }
      }

      if (finished || pastEnd) {
        const members = produced.members.get(index) ?? [];

        // A planned start ffmpeg did not cut at: serve the fragment that covers it.
        const covering =
          members.length > 0
            ? members
            : fragments
                .filter((fragment) => fragment.start <= (session.plan.starts[index] ?? 0))
                .slice(-1);

        return {
          paths: covering.map((fragment) => fragment.path),
          sizeBytes: covering.reduce((total, fragment) => total + fragment.sizeBytes, 0),
        } satisfies SegmentFiles;
      }

      if ((yield* Clock.currentTimeMillis) > deadline) return yield* new SegmentNotReady({ index });
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const lookup = Effect.fn("StreamSessions.lookup")(function* (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) {
    const session = (yield* Ref.get(sessions)).get(streamId);

    if (session === undefined) return yield* new StreamNotFound({ streamId });

    if (session.sessionId !== grant.sessionId || session.fileId !== grant.fileId) {
      return yield* new StreamAccessDenied({ streamId });
    }

    yield* touch(session);

    return session;
  });

  const currentGeneration = Effect.fnUntraced(function* (session: Session, generation: number) {
    const current = yield* Ref.get(session.generation);

    if (current.number !== generation) {
      return yield* new StreamGenerationGone({
        streamId: session.streamId,
        generation,
        currentGeneration: current.number,
      });
    }

    return current;
  });

  /** Starts a new generation at `index` unless it is already produced or about to be. */
  const ensureCovers = Effect.fn("StreamSessions.ensureCovers")(function* (
    session: Session,
    index: number,
  ) {
    return yield* session.lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(session.generation);
        yield* refreshFragments(current);
        const produced = producedRange(session, current, yield* Ref.get(current.fragments));

        if (index >= current.startSegment && index <= produced.head + LOOKAHEAD_SEGMENTS)
          return current;

        return yield* startGeneration(session, current.number + 1, index);
      }),
    );
  });

  const start = Effect.fn("StreamSessions.start")(function* (request: StartRequest) {
    const { grant, file, plan } = request;
    const transcoding = isEncode(plan.video);

    if (transcoding) {
      const acquired = yield* Ref.modify(transcodes, (running) =>
        running < config.maxConcurrentTranscodes
          ? ([true, running + 1] as const)
          : ([false, running] as const),
      );

      if (!acquired)
        return yield* new TranscodeCapacityReached({ limit: config.maxConcurrentTranscodes });
    }

    const release = transcoding ? Ref.update(transcodes, (running) => running - 1) : Effect.void;

    const available = yield* Effect.tryPromise(() => freeBytes(config.transcodeDir)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("StreamSessions.free_space_unknown").pipe(
          Effect.annotateLogs({ code: errorCode(error.cause) }),
        ),
      ),
      Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
    );

    if (available < config.minFreeTranscodeBytes) {
      yield* release;

      return yield* new InsufficientTranscodeSpace({
        freeBytes: available,
        requiredBytes: config.minFreeTranscodeBytes,
      });
    }

    const segmentPlan = isEncode(plan.video)
      ? planGridSegments(file.probe.startSeconds, file.probe.durationSeconds)
      : planKeyframeSegments(
          yield* keyframes.keyframes(file).pipe(Effect.tapError(() => release)),
          file.probe.startSeconds,
          file.probe.durationSeconds,
        );

    const streamId = yield* newStreamId;
    const scope = yield* Scope.make("sequential");

    yield* Scope.addFinalizer(scope, release);
    yield* Scope.addFinalizer(
      scope,
      fs.remove(path.join(config.transcodeDir, streamId), { recursive: true }).pipe(Effect.ignore),
    );

    const placeholder: Generation = {
      number: 0,
      startSegment: 0,
      directory: "",
      scope: yield* Scope.fork(scope, "sequential"),
      exit: yield* Deferred.make<void, MediaTools.MediaToolFailed>(),
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
    };

    const session: Session = {
      streamId,
      sessionId: grant.sessionId,
      fileId: grant.fileId,
      file,
      client: request.client,
      audioIndex: request.audioIndex,
      plan: segmentPlan,
      scope,
      mode: yield* Ref.make(plan.mode),
      video: yield* Ref.make(plan.video),
      audio: plan.audio,
      generation: yield* Ref.make(placeholder),
      lock: yield* Semaphore.make(1),
      lastActivity: yield* Ref.make(yield* Clock.currentTimeMillis),
    };

    // One stream per device session: a newer negotiation replaces the older stream.
    const replaced = yield* registry.withPermits(1)(
      Ref.modify(sessions, (current) => {
        const previous = [...current.values()].filter(
          (existing) => existing.sessionId === grant.sessionId,
        );

        const next = new Map(current);

        for (const existing of previous) next.delete(existing.streamId);
        next.set(streamId, session);

        return [previous, next] as const;
      }),
    );

    for (const previous of replaced) {
      yield* Scope.close(previous.scope, Exit.void);

      yield* reporter.report(
        PlaybackReporter.PlaybackEvent.cases.StreamEnded.make({
          sessionId: previous.sessionId,
          fileId: previous.fileId,
          streamId: previous.streamId,
          reason: "replaced",
        }),
      );
    }

    const segmentIndex = segmentAt(segmentPlan, file.probe.startSeconds + request.startSeconds);
    let generation = yield* startGeneration(session, 1, segmentIndex);

    // Wait for the first segment so the client can start at once; a QSV failure falls back here.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ready = yield* awaitSegment(session, generation, segmentIndex, START_WAIT).pipe(
        Effect.as(true),
        Effect.catchTags({
          StreamGenerationGone: () => Effect.succeed(false),
          SegmentNotReady: () => Effect.succeed(true),
        }),
        Effect.tapError(() => closeSession(session, "failed")),
      );

      if (ready) break;
      generation = yield* Ref.get(session.generation);
    }

    const mode = yield* Ref.get(session.mode);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
        sessionId: grant.sessionId,
        fileId: grant.fileId,
        streamId,
        mode,
      }),
    );

    return { streamId, generation: generation.number, mode, segmentIndex } satisfies StartedStream;
  });

  const playlist = Effect.fn("StreamSessions.playlist")(function* (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) {
    const session = yield* lookup(streamId, grant);
    yield* currentGeneration(session, generation);

    return { streamId, generation, plan: session.plan } satisfies StreamView;
  });

  const init = Effect.fn("StreamSessions.init")(function* (
    streamId: StreamId,
    generation: number,
    grant: PlaybackGrant,
  ) {
    const session = yield* lookup(streamId, grant);
    const current = yield* currentGeneration(session, generation);
    yield* awaitSegment(session, current, current.startSegment, SEGMENT_WAIT);
    const initPath = path.join(current.directory, "init.mp4");

    const info = yield* fs
      .stat(initPath)
      .pipe(Effect.mapError(() => new SegmentNotReady({ index: -1 })));

    return { paths: [initPath], sizeBytes: Number(info.size) } satisfies SegmentFiles;
  });

  const segment = Effect.fn("StreamSessions.segment")(function* (
    streamId: StreamId,
    generation: number,
    index: number,
    grant: PlaybackGrant,
  ) {
    const session = yield* lookup(streamId, grant);

    if (!Number.isInteger(index) || index < 0 || index >= session.plan.starts.length) {
      return yield* new SegmentNotFound({ index });
    }

    yield* currentGeneration(session, generation);
    const covering = yield* ensureCovers(session, index);

    if (covering.number !== generation) {
      return yield* new StreamGenerationGone({
        streamId,
        generation,
        currentGeneration: covering.number,
      });
    }

    return yield* awaitSegment(session, covering, index, SEGMENT_WAIT);
  });

  const seek = Effect.fn("StreamSessions.seek")(function* (
    streamId: StreamId,
    seconds: number,
    grant: PlaybackGrant,
  ) {
    const session = yield* lookup(streamId, grant);
    const index = segmentAt(session.plan, session.file.probe.startSeconds + seconds);
    const covering = yield* ensureCovers(session, index);

    return { streamId, generation: covering.number, plan: session.plan } satisfies StreamView;
  });

  const stop = Effect.fn("StreamSessions.stop")(function* (
    streamId: StreamId,
    grant: PlaybackGrant,
  ) {
    const session = yield* lookup(streamId, grant);
    yield* closeSession(session, "stopped");
  });

  const endSession = Effect.fn("StreamSessions.endSession")(function* (
    sessionId: PlaybackSessionId,
  ) {
    const ended = [...(yield* Ref.get(sessions)).values()].filter(
      (session) => session.sessionId === sessionId,
    );

    yield* Effect.forEach(ended, (session) => closeSession(session, "session-ended"), {
      discard: true,
    });

    return ended.length;
  });

  // Close idle sessions; the check runs several times per idle period.
  const idleMillis = Duration.toMillis(config.streamIdleTimeout);

  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    for (const session of (yield* Ref.get(sessions)).values()) {
      if (now - (yield* Ref.get(session.lastActivity)) >= idleMillis)
        yield* closeSession(session, "idle");
    }
  }).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(Math.min(5000, Math.max(100, idleMillis / 4))))),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const session of (yield* Ref.get(sessions)).values())
        yield* closeSession(session, "shutdown");
    }),
  );

  return Service.of({
    start,
    playlist,
    init,
    segment,
    seek,
    stop,
    endSession,
    activeCount: Ref.get(sessions).pipe(Effect.map((current) => current.size)),
  });
});

/** The session manager; closing the layer stops every stream and deletes its output. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | MediaTools.Service
  | KeyframeIndex.Service
  | HardwareAcceleration.Service
  | PlaybackReporter.Service
> = Layer.effect(Service, make);
