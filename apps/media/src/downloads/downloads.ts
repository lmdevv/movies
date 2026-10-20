/**
 * Downloads a device keeps: `prepare` verifies the download session's token, resolves its file,
 * and chooses what the device gets (`decideDownload`). The original file is ready at once at its
 * direct URL; anything else is an MP4 that ffmpeg writes once into `TRANSCODE_DIR/downloads`, one
 * at a time and at the lowest CPU priority, so playback always comes first. Until it is written,
 * `prepare` answers its progress. Every device asking for the same file, quality, and plan shares
 * one MP4, which is deleted six hours after its last request (or when the service restarts, as
 * `TRANSCODE_DIR` is emptied then).
 */
import { createHash } from "node:crypto";

import type { MediaFileId } from "@movies/contracts/ids";
import {
  DownloadPreparing,
  DownloadReady,
  type FileResolverUnavailable,
  InsufficientTranscodeSpace,
  type MediaFileNotFound,
  type PlaybackSessionEnded,
  type PrepareDownloadRequest,
  type PrepareDownloadResponse,
  TranscodeFailed,
  UnsupportedPlayback,
} from "@movies/contracts/media-playback";
import type { PlaybackTokenInvalid } from "@movies/contracts/playback-token";
import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { errorCode, freeBytes } from "../platform/node-directories.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { type CheckedMediaFile, resolveInsideRoots } from "../playback/file-resolver.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import { AudioPlan, VideoPlan } from "../playback/playback-decision.ts";
import { withToken } from "../playback/playback-negotiator.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import { mp4CommandArgs } from "../playback/transcode-command.ts";
import { subtitleTracks } from "../subtitles/subtitle-tracks.ts";
import { decideDownload, DownloadPlan } from "./download-plan.ts";

/** Failures `prepare` reports. */
type PrepareError =
  | PlaybackTokenInvalid
  | PlaybackSessionEnded
  | MediaFileNotFound
  | FileResolverUnavailable
  | UnsupportedPlayback
  | InsufficientTranscodeSpace
  | TranscodeFailed;

/** Prepares downloads and finds the MP4s it wrote. */
export interface Interface {
  /** Where the download of the token's file stands; starts writing its MP4 when needed. */
  readonly prepare: (
    request: PrepareDownloadRequest,
  ) => Effect.Effect<PrepareDownloadResponse, PrepareError>;
  /** The finished MP4 `name` (`<key>.mp4`) of `fileId`, or none. */
  readonly output: (fileId: MediaFileId, name: string) => Effect.Effect<Option.Option<string>>;
}

/** The downloads service. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/Downloads") {}

/** A finished MP4 nobody asked for in this long is deleted. */
const KEEP_UNUSED = Duration.hours(6);

const SWEEP_EVERY = Duration.minutes(10);

/** How often a running job's progress is read. */
const PROGRESS_EVERY = Duration.seconds(1);

/** A job writes at most this far before it is finished, so `Preparing` never reads 100 percent. */
const MOST_PROGRESS = 0.99;

/** A finished MP4's name: 24 hex characters and `.mp4`. */
const OUTPUT_NAME = /^([a-f0-9]{24})\.mp4$/u;

/** Where one MP4 job stands. */
type JobState = Data.TaggedEnum<{
  Queued: {};
  Running: {};
  Finished: { readonly sizeBytes: number };
  Failed: { readonly error: TranscodeFailed };
}>;

const JobState = Data.taggedEnum<JobState>();

/** One MP4 being written or kept. */
interface Job {
  readonly key: string;
  readonly fileId: MediaFileId;
  readonly output: string;
  readonly estimatedBytes: number;
  readonly progress: Ref.Ref<number>;
  readonly state: Ref.Ref<JobState>;
  /** Milliseconds since the epoch of the last `prepare` or byte request. */
  readonly lastUsed: Ref.Ref<number>;
}

/** The last `out_time_us` in ffmpeg's `-progress` output, in seconds. */
export const progressSeconds = (text: string): number | undefined => {
  const matches = [...text.matchAll(/^out_time_us=(\d+)$/gmu)];
  const last = matches.at(-1)?.[1];

  return last === undefined ? undefined : Number(last) / 1_000_000;
};

/** The output name of a plan for one version of a file: a hash of the file and the plan. */
const keyOf = (file: CheckedMediaFile, plan: DownloadPlan): string =>
  createHash("sha256")
    .update(JSON.stringify([file.fileId, file.sizeBytes, file.modifiedAtMs, plan]))
    .digest("hex")
    .slice(0, 24);

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const verifier = yield* PlaybackToken.Service;
  const resolver = yield* FileResolver.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map());
  // One MP4 at a time: each reads a whole file and may encode it.
  const queue = yield* Semaphore.make(1);
  const root = path.join(config.transcodeDir, "downloads");

  const forget = (job: Job) =>
    Ref.update(jobs, (current) => {
      if (current.get(job.key) !== job) return current;
      const next = new Map(current);
      next.delete(job.key);

      return next;
    });

  const touch = (job: Job) =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(job.lastUsed, now)));

  /** Writes `job`'s MP4: waits for the queue, runs ffmpeg, and keeps the file once it is whole. */
  const write = (
    job: Job,
    file: CheckedMediaFile,
    plan: Extract<DownloadPlan, { _tag: "Mp4" }>,
  ) => {
    const part = `${job.output}.part`;
    const progress = `${job.output}.progress`;
    const video = file.probe.video;
    const audioIndex = AudioPlan.$is("None")(plan.audio) ? undefined : plan.audio.index;
    const duration = Math.max(1, file.probe.durationSeconds);

    const readProgress = fs.readFileString(progress).pipe(
      Effect.map(progressSeconds),
      Effect.flatMap((seconds) =>
        seconds === undefined
          ? Effect.void
          : Ref.set(job.progress, Math.min(MOST_PROGRESS, seconds / duration)),
      ),
      Effect.ignore,
    );

    const run = Effect.gen(function* () {
      yield* Ref.set(job.state, JobState.Running());
      yield* fs.makeDirectory(path.dirname(job.output), { recursive: true });

      yield* readProgress.pipe(
        Effect.repeat(Schedule.spaced(PROGRESS_EVERY)),
        Effect.delay(PROGRESS_EVERY),
        Effect.forkScoped,
      );

      yield* tools.ffmpegInBackground(
        mp4CommandArgs({
          input: file.path,
          videoIndex: video?.index ?? 0,
          videoCodec: video?.codec ?? "",
          videoBitDepth: video?.bitDepth ?? 8,
          video: plan.video,
          audio: plan.audio,
          audioCodec: file.probe.audio.find((track) => track.index === audioIndex)?.codec ?? "",
          qsvDevice: config.qsvDevice,
          vaapiDevice: config.vaapiDevice,
          output: part,
          progress,
        }),
      );

      yield* fs.rename(part, job.output);
      const info = yield* fs.stat(job.output);

      yield* Ref.set(job.state, JobState.Finished({ sizeBytes: Number(info.size) }));
    }).pipe(Effect.scoped);

    return queue
      .withPermits(1)(run)
      .pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            yield* fs.remove(progress).pipe(Effect.ignore);

            if (Exit.isSuccess(exit)) return;
            yield* fs.remove(part).pipe(Effect.ignore);

            const failure = Cause.squash(exit.cause);
            const detail = failure instanceof Error ? failure.message : String(failure);

            yield* Effect.logWarning("Downloads.mp4_failed").pipe(
              Effect.annotateLogs({ fileId: job.fileId, mode: plan.mode }),
            );

            yield* Ref.set(
              job.state,
              JobState.Failed({
                error: new TranscodeFailed({
                  streamId: job.key,
                  mode: plan.mode,
                  detail: detail.slice(-400),
                }),
              }),
            );
            yield* touch(job);
          }),
        ),
      );
  };

  /** The job writing or holding this plan's MP4, started when there is none. */
  const jobFor = Effect.fnUntraced(function* (
    file: CheckedMediaFile,
    plan: Extract<DownloadPlan, { _tag: "Mp4" }>,
  ) {
    const key = keyOf(file, plan);
    const existing = (yield* Ref.get(jobs)).get(key);

    if (existing !== undefined) return existing;

    const available = yield* Effect.tryPromise(() => freeBytes(config.transcodeDir)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Downloads.free_space_unknown").pipe(
          Effect.annotateLogs({ code: errorCode(error.cause) }),
        ),
      ),
      Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
    );

    const required = config.minFreeTranscodeBytes + plan.estimatedBytes;

    if (available < required) {
      return yield* new InsufficientTranscodeSpace({
        freeBytes: available,
        requiredBytes: required,
      });
    }

    const fresh: Job = {
      key,
      fileId: file.fileId,
      output: path.join(root, file.fileId, `${key}.mp4`),
      estimatedBytes: plan.estimatedBytes,
      progress: yield* Ref.make(0),
      state: yield* Ref.make<JobState>(JobState.Queued()),
      lastUsed: yield* Ref.make(yield* Clock.currentTimeMillis),
    };

    // Registering the job and forking its run happen together, so no job waits for a run that
    // never started.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const [job, started] = yield* Ref.modify(
          jobs,
          (current): readonly [readonly [Job, boolean], ReadonlyMap<string, Job>] => {
            const raced = current.get(key);

            return raced === undefined
              ? [[fresh, true], new Map(current).set(key, fresh)]
              : [[raced, false], current];
          },
        );

        if (started) yield* write(job, file, plan).pipe(Effect.interruptible, Effect.forkIn(scope));

        return job;
      }),
    );
  });

  const prepare = Effect.fn("Downloads.prepare")(function* (request: PrepareDownloadRequest) {
    const grant = yield* verifier.verify(request.token);

    const file = yield* resolveInsideRoots(grant.fileId, { sidecars: true }).pipe(
      Effect.provideService(FileResolver.Service, resolver),
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    yield* Effect.annotateCurrentSpan({ fileId: grant.fileId, sessionId: grant.sessionId });

    const plan = decideDownload(file.probe, request.capabilities, request.quality, {
      audioIndex: request.audioStreamIndex,
      softwareToneMapping: yield* hardware.softwareToneMapping,
      sizeBytes: file.sizeBytes,
    });

    const video = file.probe.video;

    if (DownloadPlan.$is("Unsupported")(plan) || video === undefined) {
      return yield* new UnsupportedPlayback({
        reason: DownloadPlan.$is("Unsupported")(plan) ? plan.reason : "no-video-stream",
      });
    }

    const base = config.mediaBaseUrl;

    const subtitles = subtitleTracks(file).flatMap((track) =>
      track.kind === "text"
        ? [
            {
              id: track.id,
              source: track.source,
              codec: track.codec,
              kind: track.kind,
              language: track.language,
              title: track.title,
              forced: track.forced,
              default: track.default,
              hearingImpaired: track.hearingImpaired,
              url: withToken(
                `${base}/media/subtitles/${grant.fileId}/${track.id}.vtt`,
                request.token,
              ),
            },
          ]
        : [],
    );

    const sourceVideo = {
      codec: video.codec,
      width: video.width,
      height: video.height,
      dynamicRange: video.dynamicRange,
    };

    const audioOf = (index: number | undefined, converted: boolean) => {
      const track = file.probe.audio.find((candidate) => candidate.index === index);

      return track === undefined
        ? undefined
        : {
            streamIndex: track.index,
            codec: converted ? "aac" : track.codec,
            channels: converted ? 2 : track.channels,
          };
    };

    const common = {
      durationSeconds: file.probe.durationSeconds,
      subtitles,
      expiresAt: grant.expiresAt,
    };

    if (DownloadPlan.$is("Original")(plan)) {
      const defaultAudio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];

      return DownloadReady.make({
        ...common,
        mode: "direct",
        url: withToken(`${base}/media/direct/${grant.fileId}`, request.token),
        sizeBytes: file.sizeBytes,
        container: file.probe.container,
        video: sourceVideo,
        audio: audioOf(defaultAudio?.index, false),
      });
    }

    const job = yield* jobFor(file, plan);
    yield* touch(job);
    const state = yield* Ref.get(job.state);

    if (JobState.$is("Failed")(state)) {
      // The next request tries again.
      yield* forget(job);

      return yield* state.error;
    }

    if (!JobState.$is("Finished")(state)) {
      return DownloadPreparing.make({
        progress: yield* Ref.get(job.progress),
        estimatedBytes: job.estimatedBytes,
      });
    }

    return DownloadReady.make({
      ...common,
      mode: plan.mode,
      url: withToken(`${base}/media/downloads/${grant.fileId}/${job.key}.mp4`, request.token),
      sizeBytes: state.sizeBytes,
      container: "mp4",
      video: VideoPlan.$match(plan.video, {
        Copy: () => sourceVideo,
        Encode: ({ width, height }) => ({
          codec: "h264",
          width,
          height,
          dynamicRange: "sdr" as const,
        }),
      }),
      audio: AudioPlan.$match(plan.audio, {
        None: () => undefined,
        Copy: ({ index }) => audioOf(index, false),
        Aac: ({ index }) => audioOf(index, true),
      }),
    });
  });

  const output = Effect.fn("Downloads.output")(function* (fileId: MediaFileId, name: string) {
    const key = OUTPUT_NAME.exec(name)?.[1];
    const job = key === undefined ? undefined : (yield* Ref.get(jobs)).get(key);

    if (job?.fileId !== fileId || !JobState.$is("Finished")(yield* Ref.get(job.state))) {
      return Option.none<string>();
    }

    yield* touch(job);

    return Option.some(job.output);
  });

  /** Deletes finished and failed MP4s nobody asked for within `KEEP_UNUSED`. */
  const sweep = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(KEEP_UNUSED);

    for (const job of (yield* Ref.get(jobs)).values()) {
      const state = yield* Ref.get(job.state);
      const settled = JobState.$is("Finished")(state) || JobState.$is("Failed")(state);

      if (settled && (yield* Ref.get(job.lastUsed)) < cutoff) {
        yield* forget(job);
        yield* fs.remove(job.output).pipe(Effect.ignore);
      }
    }
  });

  yield* sweep.pipe(
    Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
    Effect.delay(SWEEP_EVERY),
    Effect.forkScoped,
  );

  return Service.of({ prepare, output });
});

/** Downloads over the media tools, the file resolver, and the token verifier. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | PlaybackToken.Service
  | FileResolver.Service
  | HardwareAcceleration.Service
  | MediaTools.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(Service, make);
