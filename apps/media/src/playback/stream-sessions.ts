import {
  type ClientCapabilities,
  type InsufficientTranscodeSpace,
  type PlaybackQuality,
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
  Predicate,
  Ref,
  Schedule,
  Scope,
  Semaphore,
} from "effect";

import type { MediaFileId, PlaybackSessionId, UserId } from "@movies/contracts/ids";
import { StreamId } from "@movies/contracts/media-playback";
import { LogEvent } from "../diagnostics/log-events.ts";
import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "./file-resolver.ts";
import { FRAGMENT_HEAD_BYTES, fragmentStartSeconds } from "./fmp4-fragments.ts";
import * as HardwareAcceleration from "./hardware-acceleration.ts";
import { planGridSegments, planKeyframeSegments, type SegmentPlan, segmentAt } from "./hls-plan.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import type { PlaybackGrant } from "./playback-token.ts";
import * as StreamOwners from "./stream-owners.ts";
import * as TranscodeSpace from "./transcode-space.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

interface StartRequest {
  readonly grant: PlaybackGrant;
  readonly file: ResolvedMediaFile;
  readonly plan: Extract<PlaybackPlan, { readonly _tag: "Hls" }>;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly startSeconds: number;
  readonly quality: PlaybackQuality | undefined;
  readonly burnSubtitle: number | undefined;
  readonly keyframes: ReadonlyArray<number> | undefined;
}

interface StartedStream {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly mode: Exclude<PlaybackMode, "direct">;
  readonly segmentIndex: number;
}

interface StreamView {
  readonly streamId: StreamId;
  readonly generation: number;
  readonly plan: SegmentPlan;
}

interface SegmentFiles {
  readonly paths: ReadonlyArray<string>;
  readonly sizeBytes: number;
}

type StreamRequestError =
  | StreamNotFound
  | StreamAccessDenied
  | StreamGenerationGone
  | SegmentNotFound
  | SegmentNotReady
  | TranscodeFailed
  | UnsupportedPlayback;

/** Failures of starting a stream. `StreamNotFound`: a newer negotiation replaced it meanwhile. */
export type StartError =
  | StreamNotFound
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

const LOOKAHEAD_SEGMENTS = 3;

const THROTTLE_INTERVAL = Duration.seconds(1);

const TIME_EPSILON = 0.005;

const POLL_INTERVAL = Duration.millis(50);

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
  readonly from: number;
  readonly directory: string;
  readonly scope: Scope.Closeable;
  readonly exit: Deferred.Deferred<void, MediaTools.MediaToolFailed>;
  readonly fragments: Ref.Ref<ReadonlyArray<Fragment>>;
  readonly refreshLock: Semaphore.Semaphore;
  readonly suspend: (paused: boolean) => Effect.Effect<void>;
  readonly paused: Ref.Ref<boolean>;
}

interface Session {
  readonly streamId: StreamId;
  readonly sessionId: PlaybackSessionId;
  readonly userId: UserId;
  readonly fileId: MediaFileId;
  readonly file: ResolvedMediaFile;
  readonly client: ClientCapabilities;
  readonly audioIndex: number | undefined;
  readonly quality: PlaybackQuality | undefined;
  readonly burnSubtitle: number | undefined;
  readonly plan: SegmentPlan;
  readonly scope: Scope.Closeable;
  readonly mode: Ref.Ref<Exclude<PlaybackMode, "direct">>;
  readonly video: Ref.Ref<VideoPlan>;
  readonly audio: AudioPlan;
  readonly generation: Ref.Ref<Generation>;
  readonly lock: Semaphore.Semaphore;
  readonly lastActivity: Ref.Ref<number>;
  readonly requested: Ref.Ref<number>;
  readonly served: Ref.Ref<boolean>;
}

interface Produced {
  readonly members: ReadonlyMap<number, ReadonlyArray<Fragment>>;
  readonly head: number;
}

const isEncode = VideoPlan.$is("Encode");

const HARDWARE_MODES: Partial<Record<PlaybackMode, HardwareAcceleration.HardwareEncoder>> = {
  "transcode-qsv": "qsv",
  "transcode-vaapi": "vaapi",
};

const hardwareOf = (mode: PlaybackMode): HardwareAcceleration.HardwareEncoder | undefined =>
  HARDWARE_MODES[mode];

const isClosed = (scope: Scope.Scope): boolean => Predicate.isTagged(scope.state, "Closed");

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tools = yield* MediaTools.Service;
  const keyframes = yield* KeyframeIndex.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const space = yield* TranscodeSpace.Service;
  const owners = yield* StreamOwners.Service;
  const sessions = yield* Ref.make<ReadonlyMap<StreamId, Session>>(new Map());
  const transcodes = yield* Ref.make(0);
  const copies = yield* Ref.make(0);
  const registry = yield* Semaphore.make(1);

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
      yield* owners.closed(session.streamId);
      yield* reporter.report(
        PlaybackReporter.PlaybackEvent.cases.StreamEnded.make({
          sessionId: session.sessionId,
          userId: session.userId,
          fileId: session.fileId,
          streamId: session.streamId,
          reason,
        }),
      );
    }
  }, Effect.uninterruptible);

  const refreshFragments = Effect.fnUntraced(
    function* (generation: Generation) {
      const known = new Set(
        (yield* Ref.get(generation.fragments)).map((fragment) => fragment.path),
      );

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
    },
    (refresh, generation) => generation.refreshLock.withPermits(1)(refresh),
  );

  const producedRange = (
    session: Session,
    generation: Generation,
    fragments: ReadonlyArray<Fragment>,
  ): Produced => {
    // ffmpeg's stream-copy seek can start a keyframe or more before `from`, and a keyframe index a
    // few milliseconds late puts `from` just after the fragment that starts the segment.
    const lead = fragments.findLastIndex(
      (fragment) => fragment.start <= generation.from + TIME_EPSILON,
    );

    const members = new Map<number, Array<Fragment>>();

    for (const fragment of fragments.slice(Math.max(0, lead))) {
      const index = Math.max(
        generation.startSegment,
        segmentAt(session.plan, fragment.start + TIME_EPSILON),
      );

      members.set(index, [...(members.get(index) ?? []), fragment]);
    }

    return { members, head: Math.max(generation.startSegment, ...members.keys()) };
  };

  const startGeneration = Effect.fn("StreamSessions.startGeneration")(function* (
    session: Session,
    number: number,
    startSegment: number,
  ) {
    const directory = path.join(config.transcodeDir, session.streamId, String(number));
    const scope = yield* Scope.fork(session.scope, "sequential");
    const closed = new StreamNotFound({ streamId: session.streamId });

    // A closed session hands out a closed scope, whose finalizers would run before the folder exists.
    if (isClosed(scope)) return yield* closed;
    yield* Scope.addFinalizer(scope, fs.remove(directory, { recursive: true }).pipe(Effect.ignore));
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);

    if (isClosed(scope)) {
      yield* fs.remove(directory, { recursive: true }).pipe(Effect.ignore);

      return yield* closed;
    }

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
      audioCodec: AudioPlan.$match(session.audio, {
        None: () => "",
        Aac: () => "",
        Copy: ({ index }) =>
          session.file.probe.audio.find((track) => track.index === index)?.codec ?? "",
      }),
      segmentStarts: session.plan.starts.slice(startSegment),
      subtitleCodec:
        session.file.probe.subtitles.find((track) => track.index === session.burnSubtitle)?.codec ??
        "",
      outputDirectory: directory,
      qsvDevice: hardware.qsvDevice,
      vaapiDevice: hardware.vaapiDevice,
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
      from,
      directory,
      scope,
      exit,
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      suspend: running === undefined ? () => Effect.void : running.suspend,
      paused: yield* Ref.make(false),
    };

    yield* Ref.set(session.requested, startSegment);

    if (number > 1) {
      yield* Effect.logInfo(LogEvent.streamMoved).pipe(
        Effect.annotateLogs({
          sessionId: session.sessionId,
          userId: session.userId,
          streamId: session.streamId,
          generation: number,
          segment: startSegment,
          fromSeconds: from,
        }),
      );
    }

    const previous = yield* Ref.getAndSet(session.generation, generation);

    if (previous.number !== number) yield* Scope.close(previous.scope, Exit.void);

    return generation;
  });

  const fallBackToSoftware = Effect.fn("StreamSessions.fallBackToSoftware")(function* (
    session: Session,
    encoder: HardwareAcceleration.HardwareEncoder,
    detail: string,
  ) {
    yield* hardware.markUnavailable(encoder, detail);

    const plan = decidePlayback(session.file.probe, session.client, {
      audioIndex: session.audioIndex,
      hardware: undefined,
      softwareToneMapping: yield* hardware.softwareToneMapping,
      quality: session.quality,
      burnSubtitle: session.burnSubtitle,
      copyVideo: false,
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
        userId: session.userId,
        fileId: session.fileId,
        streamId: session.streamId,
        from,
        to: plan.mode,
        reason: "hardware-unavailable",
      }),
    );

    return plan.mode;
  });

  const encoderFailed = Effect.fn("StreamSessions.encoderFailed")(function* (
    session: Session,
    generation: Generation,
    index: number,
    detail: string,
  ) {
    const restarted = yield* session.lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(session.generation);

        if (current.number !== generation.number) return current;
        const mode = yield* Ref.get(session.mode);

        yield* Effect.annotateCurrentSpan({
          streamId: session.streamId,
          mode,
          segmentIndex: index,
        });
        yield* Effect.logWarning(LogEvent.encoderFailed).pipe(
          Effect.annotateLogs({
            sessionId: session.sessionId,
            userId: session.userId,
            streamId: session.streamId,
            mode,
            generation: generation.number,
            detail,
          }),
        );

        const encoder = hardwareOf(mode);

        if (encoder === undefined) {
          return yield* new TranscodeFailed({ streamId: session.streamId, mode, detail });
        }

        yield* fallBackToSoftware(session, encoder, detail);

        return yield* startGeneration(session, generation.number + 1, index);
      }),
    );

    return yield* new StreamGenerationGone({
      streamId: session.streamId,
      generation: generation.number,
      currentGeneration: restarted.number,
    });
  });

  const awaitSegment = Effect.fn("StreamSessions.awaitSegment")(function* (
    session: Session,
    generation: Generation,
    index: number,
    maxWait: Duration.Duration,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(maxWait);

    for (;;) {
      if (isClosed(session.scope)) return yield* new StreamNotFound({ streamId: session.streamId });
      const current = yield* Ref.get(session.generation);

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
          const detail = Exit.match(result, {
            onSuccess: () => "",
            onFailure: (cause) => String(cause),
          }).slice(-300);

          const neverServed = !(yield* Ref.get(session.served));

          return yield* encoderFailed(session, generation, index, detail).pipe(
            Effect.tapErrorTag("TranscodeFailed", () =>
              neverServed ? closeSession(session, "failed") : Effect.void,
            ),
          );
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

        yield* Ref.set(session.served, true);

        return {
          paths: covering.map((fragment) => fragment.path),
          sizeBytes: covering.reduce((total, fragment) => total + fragment.sizeBytes, 0),
        } satisfies SegmentFiles;
      }

      if ((yield* Clock.currentTimeMillis) > deadline) return yield* new SegmentNotReady({ index });
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const pauseAhead = Duration.toSeconds(config.streamBufferAhead);

  const throttle = Effect.fnUntraced(function* (session: Session) {
    const generation = yield* Ref.get(session.generation);

    if (generation.number === 0 || (yield* Deferred.isDone(generation.exit))) return;
    yield* refreshFragments(generation);
    const produced = producedRange(session, generation, yield* Ref.get(generation.fragments));
    const requested = yield* Ref.get(session.requested);
    const startOf = (index: number) => session.plan.starts[index] ?? session.plan.end;
    const ahead = startOf(produced.head) - startOf(requested);
    const paused = yield* Ref.get(generation.paused);

    if (!paused && ahead > pauseAhead) {
      yield* generation.suspend(true);
      yield* Ref.set(generation.paused, true);
    } else if (paused && ahead < pauseAhead / 2) {
      yield* generation.suspend(false);
      yield* Ref.set(generation.paused, false);
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

  const firstSegment = Effect.fn("StreamSessions.firstSegment")(function* (
    session: Session,
    segmentIndex: number,
  ) {
    yield* Effect.annotateCurrentSpan({ streamId: session.streamId, segmentIndex });
    let generation = yield* startGeneration(session, 1, segmentIndex);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ready = yield* awaitSegment(session, generation, segmentIndex, START_WAIT).pipe(
        Effect.as(true),
        Effect.catchTags({
          StreamGenerationGone: () => Effect.succeed(false),
          SegmentNotReady: () => Effect.succeed(true),
        }),
      );

      if (ready) break;
      generation = yield* Ref.get(session.generation);
    }

    yield* Effect.annotateCurrentSpan({ mode: yield* Ref.get(session.mode) });

    return generation;
  });

  const acquireSlot = (scope: Scope.Scope, transcoding: boolean, replacing: number) => {
    const slots = transcoding ? transcodes : copies;
    const limit = transcoding ? config.maxConcurrentTranscodes : config.maxConcurrentRemuxes;

    return Ref.modify(slots, (running) =>
      running - replacing < limit ? ([true, running + 1] as const) : ([false, running] as const),
    ).pipe(
      Effect.tap((acquired) =>
        acquired
          ? Scope.addFinalizer(
              scope,
              Ref.update(slots, (running) => running - 1),
            )
          : Effect.void,
      ),
      Effect.uninterruptible,
      Effect.flatMap((acquired) =>
        acquired ? Effect.void : Effect.fail(new TranscodeCapacityReached({ limit })),
      ),
    );
  };

  const start = Effect.fn("StreamSessions.start")(function* (request: StartRequest) {
    const scope = yield* Scope.make("sequential");
    const registered = yield* Ref.make(Option.none<Session>());

    return yield* startIn(scope, registered, request).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Ref.get(registered).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Scope.close(scope, Exit.void),
                  onSome: (session) =>
                    closeSession(session, Exit.hasInterrupts(exit) ? "abandoned" : "failed"),
                }),
              ),
            ),
      ),
    );
  });

  const startIn = Effect.fnUntraced(function* (
    scope: Scope.Closeable,
    registered: Ref.Ref<Option.Option<Session>>,
    request: StartRequest,
  ) {
    const { grant, file, plan } = request;

    const transcoding = isEncode(plan.video);

    const replacing = yield* Effect.filter(
      [...(yield* Ref.get(sessions)).values()].filter(
        (existing) => existing.sessionId === grant.sessionId,
      ),
      (existing) =>
        Ref.get(existing.video).pipe(Effect.map((video) => isEncode(video) === transcoding)),
    );

    yield* acquireSlot(scope, transcoding, replacing.length);

    yield* space.check(0);

    const quickStart = file.probe.startSeconds + request.startSeconds;

    const segmentPlan = isEncode(plan.video)
      ? planGridSegments(file.probe.startSeconds, file.probe.durationSeconds, { quickStart })
      : planKeyframeSegments(
          request.keyframes ?? (yield* keyframes.keyframes(file)),
          file.probe.startSeconds,
          file.probe.durationSeconds,
          { quickStart },
        );

    const streamId = yield* newStreamId;

    yield* Scope.addFinalizer(
      scope,
      fs.remove(path.join(config.transcodeDir, streamId), { recursive: true }).pipe(Effect.ignore),
    );

    const placeholder: Generation = {
      number: 0,
      startSegment: 0,
      from: segmentPlan.starts[0] ?? segmentPlan.end,
      directory: "",
      scope: yield* Scope.fork(scope, "sequential"),
      exit: yield* Deferred.make<void, MediaTools.MediaToolFailed>(),
      fragments: yield* Ref.make<ReadonlyArray<Fragment>>([]),
      refreshLock: yield* Semaphore.make(1),
      suspend: () => Effect.void,
      paused: yield* Ref.make(false),
    };

    const session: Session = {
      streamId,
      sessionId: grant.sessionId,
      userId: grant.userId,
      fileId: grant.fileId,
      file,
      client: request.client,
      audioIndex: request.audioIndex,
      quality: request.quality,
      burnSubtitle: request.burnSubtitle,
      plan: segmentPlan,
      scope,
      mode: yield* Ref.make(plan.mode),
      video: yield* Ref.make(plan.video),
      audio: plan.audio,
      generation: yield* Ref.make(placeholder),
      lock: yield* Semaphore.make(1),
      lastActivity: yield* Ref.make(yield* Clock.currentTimeMillis),
      requested: yield* Ref.make(0),
      served: yield* Ref.make(false),
    };

    yield* throttle(session).pipe(
      Effect.repeat(Schedule.spaced(THROTTLE_INTERVAL)),
      Effect.forkIn(scope),
    );

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const replaced = yield* registry.withPermits(1)(
          Ref.modify(sessions, (current) => {
            const previous = [...current.values()].filter(
              (existing) => existing.sessionId === grant.sessionId,
            );

            const next = new Map(current);

            for (const existing of previous) next.delete(existing.streamId);
            next.set(streamId, session);

            return [previous, next] as const;
          }).pipe(
            Effect.tap(() => Ref.set(registered, Option.some(session))),
            Effect.tap((previous) =>
              Effect.forEach(previous, (existing) => owners.closed(existing.streamId), {
                discard: true,
              }),
            ),
            Effect.tap(() => owners.opened(streamId, grant.sessionId)),
          ),
        );

        for (const previous of replaced) {
          yield* Scope.close(previous.scope, Exit.void);

          yield* reporter.report(
            PlaybackReporter.PlaybackEvent.cases.StreamEnded.make({
              sessionId: previous.sessionId,
              userId: previous.userId,
              fileId: previous.fileId,
              streamId: previous.streamId,
              reason: "replaced",
            }),
          );
        }
      }),
    );

    const segmentIndex = segmentAt(segmentPlan, quickStart);

    const generation =
      hardwareOf(plan.mode) !== undefined
        ? yield* firstSegment(session, segmentIndex)
        : yield* startGeneration(session, 1, segmentIndex);

    const mode = yield* Ref.get(session.mode);

    yield* reporter.report(
      PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
        sessionId: grant.sessionId,
        userId: grant.userId,
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
    yield* Ref.update(session.requested, (furthest) => Math.max(furthest, index));
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
    yield* Effect.annotateCurrentSpan({
      streamId,
      segmentIndex: index,
      generation: covering.number,
    });

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
  | TranscodeSpace.Service
  | StreamOwners.Service
> = Layer.effect(Service, make);
