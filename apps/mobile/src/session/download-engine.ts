/**
 * Downloads on this iPhone, the imperative shell over `lib/downloads/model`: it keeps one
 * account's store in `downloads/<server>/<account>/index.json` and works through it two downloads
 * at a time. Each download starts a download session in Convex (`downloads.start`), asks the media
 * service to prepare it until it is ready, checks the space it needs (H21), keeps its text
 * subtitles and picture, and transfers the video in a background-capable iOS download task, which
 * pauses (and keeps its resume data) when Wi-Fi Only finds no Wi-Fi. Failures follow
 * `afterDownloadFailure`; the progress played offline goes to the server whenever it is reachable.
 *
 * Every SDK call runs on the app's SDK runtime and comes back as a value; nothing here throws.
 */
import type { PrepareDownloadResponse } from "@movies/contracts/media-playback";
import type { StartedPlayback } from "@movies/contracts/models/playback";
import type { DeviceId } from "@movies/contracts/ids";
import { EpochMillis, Milliseconds } from "@movies/contracts/units";
import type { CallError, Movies, PlaybackCallError } from "@movies/sdk/effect";
import { Downloads, MoviesClient } from "@movies/sdk/effect";
import type { useMoviesRuntime } from "@movies/sdk/react";
import { Effect, Exit, Option, Predicate, Result, Schema } from "effect";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import type { DownloadPauseState } from "expo-file-system";

import { artworkUrl } from "@/lib/artwork";
import {
  ARTWORK_FILE,
  STORE_FILE,
  itemFolder,
  subtitleFile,
  videoFile,
} from "@/lib/downloads/files";
import { DownloadStep, SERVER_UNAVAILABLE, afterDownloadFailure } from "@/lib/downloads/failures";
import {
  DownloadEvent,
  mayTransfer,
  nextToRun,
  parseStore,
  reduce,
  serializeStore,
  spaceShortfall,
} from "@/lib/downloads/model";
import type {
  Delivery,
  DownloadRecord,
  DownloadStore,
  NetworkNow,
  NewDownload,
  PendingProgress,
} from "@/lib/downloads/model";
import type { DownloadSettings } from "@/lib/downloads/settings";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";

/** The app's SDK runtime. */
type Runtime = ReturnType<typeof useMoviesRuntime>;

/** The media service's answer once a download is ready to fetch. */
type DownloadReady = Extract<PrepareDownloadResponse, { readonly _tag: "Ready" }>;

/** Everything the screens read. */
export interface DownloadsSnapshot {
  readonly store: DownloadStore;
  readonly settings: DownloadSettings;
  readonly network: NetworkNow;
}

/** Where an engine keeps its files and who it downloads for. */
export interface EngineOptions {
  /** The account's folder, `downloads/<server>/<account>` under the documents folder. */
  readonly folder: Directory;
  readonly mediaUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly settings: DownloadSettings;
}

/** How long to wait between asking the media service about a download it prepares. */
const PREPARE_EVERY_MS = 3_000;

/** How long to wait before asking a busy media service again. */
const BUSY_RETRY_MS = 10_000;

/** A transfer without progress for this long asks whether its server still answers. */
const STALL_AFTER_MS = 20_000;

/** How often a transfer's progress is looked at for a stall. */
const STALL_CHECK_MS = 5_000;

/** How long the media service's health check may take before the server counts as gone. */
const HEALTH_TIMEOUT_MS = 5_000;

/** Renew the session's token when it expires within this long. */
const RENEW_BEFORE_MS = 30 * 60 * 1000;

/**
 * Downloads worked on at once: one the media service still prepares (a long encode) does not hold
 * up the next, whose file may be ready to transfer at once.
 */
const MAX_RUNS = 2;

/** New sessions in a row before a download gives up. */
const MAX_RESTARTS = 3;

/** How often a transfer's progress is kept on disk. */
const SAVE_EVERY_MS = 2_000;

/** How often a transfer's progress reaches the screens. */
const SHOW_EVERY_MS = 500;

const DownloadPauseStateJson = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    fileUri: Schema.String,
    isDirectory: Schema.Boolean,
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    // A state without resume data (paused before any bytes arrived) cannot be resumed.
    resumeData: Schema.NonEmptyString,
  }),
);

const decodePauseState = Schema.decodeUnknownOption(DownloadPauseStateJson);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The transfer working on one download. */
interface Active {
  readonly id: string;
  task: DownloadTask | null;
  sessionId: StartedPlayback["sessionId"] | null;
  /** Removed or cancelled: stop at the next step and leave nothing behind. */
  cancelled: boolean;
  /** Paused for Wi-Fi Only: the task's own promise resolves with null. */
  pausing: boolean;
}

/** Where preparing a download stands between its questions to the media service. */
interface Preparation {
  /** The session asked with; null before one started, or after it ended. */
  readonly started: StartedPlayback | null;
  /** The token expired: renew it before asking again. */
  readonly renew: boolean;
  /** Renewals and new sessions so far. */
  readonly restarts: number;
}

/** What the media service delivers, as the store keeps it. */
const deliveryOf = (
  ready: DownloadReady,
  started: StartedPlayback,
  kept: ReadonlySet<string>,
): Delivery => ({
  fileId: started.file.id,
  sizeBytes: ready.sizeBytes,
  container: ready.container === "mov" ? "mov" : "mp4",
  durationMs: Math.round(ready.durationSeconds * 1000),
  videoCodec: ready.video.codec,
  width: ready.video.width,
  height: ready.video.height,
  audio: ready.audio ?? null,
  subtitles: ready.subtitles.flatMap((subtitle) =>
    kept.has(subtitle.id)
      ? [
          {
            id: subtitle.id,
            language: subtitle.language ?? null,
            title: subtitle.title ?? null,
            forced: subtitle.forced,
            default: subtitle.default,
            hearingImpaired: subtitle.hearingImpaired,
          },
        ]
      : [],
  ),
});

/** Keeps and downloads one account's downloads. Create it, then `dispose` it. */
export class DownloadEngine {
  readonly #runtime: Runtime;
  readonly #options: EngineOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: DownloadsSnapshot;
  /** The downloads being worked on, by ID. */
  readonly #active = new Map<string, Active>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  /** Each download's kept picture, once looked for: its URI, or null when there is none. */
  readonly #artwork = new Map<string, string | null>();
  #sending = false;
  #started = false;
  #disposed = false;

  constructor(runtime: Runtime, options: EngineOptions) {
    this.#runtime = runtime;
    this.#options = options;

    const stored = parseStore(this.#readStore());

    // Transfers do not outlive the app: what was under way waits its turn again, keeping any
    // resume data it saved.
    const settled = stored.downloads.reduce(
      (store, download) =>
        download.phase === "preparing" || download.phase === "downloading"
          ? reduce(
              store,
              DownloadEvent.Waiting({ id: download.id, wifi: false, resume: download.resume }),
            )
          : store,
      stored,
    );

    this.#snapshot = {
      store: settled,
      settings: options.settings,
      // Unknown until the first report: nothing transfers before it, so not over mobile data.
      network: { connected: false, wifi: false },
    };
  }

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): DownloadsSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Starts working, once the account is confirmed signed in here: the first download in line, and
   * any progress waiting for the server. Until then the engine only shows what is kept.
   */
  start(): void {
    this.#started = true;
    this.#pump();
    void this.sendProgress();
  }

  /** Stops every transfer for good, keeping what was saved; the engine does nothing after. */
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#showTimer);
    this.#save();

    for (const active of this.#active.values()) active.task?.cancel();
  }

  /** Queues a download; one already kept for the same item stays as it is. */
  add(download: NewDownload): void {
    this.#dispatch(DownloadEvent.Added({ download, at: Date.now() }));
    this.#pump();
  }

  /** Queues an interrupted or stopped download again (Retry Download). */
  retry(id: string): void {
    this.#dispatch(DownloadEvent.Retried({ id }));
    this.#pump();
  }

  /** Cancels a download or removes a kept one, deleting its files (Remove, Cancel Download). */
  async remove(id: string): Promise<void> {
    const active = this.#active.get(id);

    if (active !== undefined) {
      active.cancelled = true;
      active.task?.cancel();
      this.#endSession(active.sessionId);
    }

    this.#deleteFiles(id);
    this.#dispatch(DownloadEvent.Removed({ id }));
    await Promise.resolve();
    this.#pump();
  }

  /** Removes every download of one profile (Remove All Downloads). */
  async removeAll(profileId: DownloadRecord["profileId"]): Promise<void> {
    const ids = this.#snapshot.store.downloads
      .filter((download) => download.profileId === profileId)
      .map((download) => download.id);

    await Promise.all(ids.map((id) => this.remove(id)));
  }

  /** Records where a download was played to, and sends it on when the server is reachable. */
  played(id: string, positionMs: number, durationMs: number): void {
    this.#dispatch(
      DownloadEvent.Played({
        id,
        positionMs: Math.max(0, Math.round(positionMs)),
        durationMs: Math.max(0, Math.round(durationMs)),
        at: Date.now(),
      }),
    );
    void this.sendProgress();
  }

  /** Applies new settings: a transfer pauses when Wi-Fi Only now forbids it. */
  setSettings(settings: DownloadSettings): void {
    this.#snapshot = { ...this.#snapshot, settings };
    this.#notify();
    this.#reconsider();
  }

  /** Applies a network change: transfers pause off Wi-Fi under Wi-Fi Only, and resume on it. */
  setNetwork(network: NetworkNow): void {
    this.#snapshot = { ...this.#snapshot, network };
    this.#notify();
    this.#reconsider();

    if (network.connected) void this.sendProgress();
  }

  /** The kept video of `download`, or null before it is ready. */
  videoUri(download: DownloadRecord): string | null {
    if (download.phase !== "ready" || download.delivery === null) return null;

    return new File(this.#itemDirectory(download.id), videoFile(download.delivery.container)).uri;
  }

  /** The kept WebVTT file of a subtitle track. */
  subtitleUri(download: DownloadRecord, trackId: string): string {
    return new File(this.#itemDirectory(download.id), subtitleFile(trackId)).uri;
  }

  /** The kept picture of `download`, or null when there is none yet. */
  artworkUri(download: DownloadRecord): string | null {
    const known = this.#artwork.get(download.id);

    if (known !== undefined) return known;
    const file = new File(this.#itemDirectory(download.id), ARTWORK_FILE);
    const uri = file.exists ? file.uri : null;

    this.#artwork.set(download.id, uri);

    return uri;
  }

  /** Sends the progress played offline; what the server took or refused for good leaves the queue. */
  async sendProgress(): Promise<void> {
    const pending = this.#snapshot.store.pendingProgress;

    if (!this.#started || this.#sending || pending.length === 0) return;

    if (!this.#snapshot.network.connected) return;
    this.#sending = true;

    try {
      const sent = await this.#sendFrom(pending, []);

      if (sent.length > 0) this.#dispatch(DownloadEvent.ProgressSent({ sent }));
    } finally {
      this.#sending = false;
    }
  }

  /** Sends `pending` one at a time until the server cannot be reached; returns what it took. */
  async #sendFrom(
    pending: ReadonlyArray<PendingProgress>,
    sent: ReadonlyArray<PendingProgress>,
  ): Promise<ReadonlyArray<PendingProgress>> {
    const [entry, ...rest] = pending;

    if (entry === undefined) return sent;

    const result = await this.#runSdk(
      Effect.flatMap(MoviesClient.MoviesClient, (client) =>
        client.mutate("downloads.recordProgress", {
          profileId: entry.profileId,
          titleId: entry.titleId,
          fileId: entry.fileId,
          positionMs: Milliseconds.make(entry.positionMs),
          durationMs: Milliseconds.make(entry.durationMs),
          playedAt: EpochMillis.make(entry.playedAt),
          // This clock now, so the server corrects `playedAt` if this iPhone's clock is off.
          sentAt: EpochMillis.make(Date.now()),
          ...Option.match(Option.fromNullishOr(entry.episodeId), {
            onNone: () => ({}),
            onSome: (episodeId) => ({ episodeId }),
          }),
        }),
      ),
    );

    // Unreachable: keep the rest for later.
    if (result === null || (Result.isFailure(result) && isUnreachable(result.failure))) return sent;

    // A refusal for good (the title is gone, the profile lost it) leaves the queue; any other
    // failure keeps this entry for the next try and goes on with the rest.
    const taken = Result.isSuccess(result) || isFinal(result.failure);

    return this.#sendFrom(rest, taken ? [...sent, entry] : sent);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #dispatch(event: DownloadEvent, save: "now" | "soon" = "now"): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, store: reduce(this.#snapshot.store, event) };

    if (save === "now") {
      this.#notify();
      this.#save();
    } else {
      // Transfer progress arrives many times a second; the screens and the disk take it in turns.
      this.#showTimer ??= setTimeout(() => {
        this.#showTimer = undefined;
        this.#notify();
      }, SHOW_EVERY_MS);
      this.#saveTimer ??= setTimeout(() => this.#save(), SAVE_EVERY_MS);
    }
  }

  #readStore(): string | null {
    try {
      const file = new File(this.#options.folder, STORE_FILE);

      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  }

  #save(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;

    try {
      this.#options.folder.create({ intermediates: true, idempotent: true });
      new File(this.#options.folder, STORE_FILE).writeSync(serializeStore(this.#snapshot.store));
    } catch {
      // A full disk keeps the store in memory for this launch.
    }
  }

  #itemDirectory(id: string): Directory {
    return new Directory(this.#options.folder, itemFolder(id));
  }

  #deleteFiles(id: string): void {
    this.#artwork.delete(id);

    try {
      const directory = this.#itemDirectory(id);

      if (directory.exists) directory.delete();
    } catch {
      // Already gone.
    }
  }

  async #runSdk<A, E>(
    effect: Effect.Effect<A, E, Movies.Services>,
  ): Promise<Result.Result<A, E> | null> {
    const exit = await this.#runtime.runPromiseExit(Effect.result(effect));

    return Exit.isSuccess(exit) ? exit.value : null;
  }

  #endSession(sessionId: StartedPlayback["sessionId"] | null): void {
    if (sessionId === null) return;

    void this.#runSdk(
      Effect.flatMap(MoviesClient.MoviesClient, (client) =>
        client.mutate("downloads.end", { sessionId }),
      ),
    );
  }

  /** Pauses the transfers the network no longer allows, or starts the next one now allowed. */
  #reconsider(): void {
    const { network, settings } = this.#snapshot;

    if (this.#active.size > 0 && !mayTransfer(network, settings.wifiOnly)) {
      // Off Wi-Fi under Wi-Fi Only it waits for Wi-Fi; offline it waits for its turn again.
      const wifi = network.connected && settings.wifiOnly;

      for (const active of this.#active.values()) void this.#pauseForNetwork(active, wifi);

      return;
    }

    this.#pump();
  }

  async #pauseForNetwork(active: Active, wifi: boolean): Promise<void> {
    const task = active.task;

    if (active.pausing) return;
    active.pausing = true;

    if (task === null) {
      // Still preparing: the run stops at its next step, and the download waits.
      this.#endSession(active.sessionId);
      const waiting = this.#snapshot.store.downloads.find((download) => download.id === active.id);

      this.#dispatch(
        DownloadEvent.Waiting({ id: active.id, wifi, resume: waiting?.resume ?? null }),
      );

      return;
    }

    const resume = await pauseKeeping(task);

    this.#dispatch(DownloadEvent.Waiting({ id: active.id, wifi, resume }));
  }

  /** Starts the next downloads in line, up to `MAX_RUNS` at once, when the network allows it. */
  #pump(): void {
    if (!this.#started || this.#active.size >= MAX_RUNS || this.#disposed) return;
    const { store, network, settings } = this.#snapshot;
    const next = nextToRun(store, new Set(this.#active.keys()));

    if (next === null) return;

    if (!mayTransfer(network, settings.wifiOnly)) {
      // On mobile data under Wi-Fi Only, everything in line waits for Wi-Fi.
      if (network.connected && settings.wifiOnly) {
        for (const download of store.downloads) {
          if (download.phase === "queued") {
            this.#dispatch(
              DownloadEvent.Waiting({ id: download.id, wifi: true, resume: download.resume }),
            );
          }
        }
      }

      return;
    }

    const active: Active = {
      id: next.id,
      task: null,
      sessionId: null,
      cancelled: false,
      pausing: false,
    };

    this.#active.set(next.id, active);
    // A run that throws (a defect) leaves its download in line; the check below interrupts it.
    void this.#run(next, active)
      .catch(() => undefined)
      .finally(() => {
        if (this.#active.get(next.id) === active) this.#active.delete(next.id);

        // A run always moves its download on; one left in line would start again at once, forever.
        const left = this.#snapshot.store.downloads.find((download) => download.id === next.id);

        if (left?.phase === "queued" && !active.cancelled) {
          this.#dispatch(
            DownloadEvent.Interrupted({ id: next.id, error: SERVER_UNAVAILABLE, resume: null }),
          );
        }

        this.#pump();
      });

    // A second download can transfer while the first is still being prepared by the server.
    this.#pump();
  }

  /** Whether the run should stop here: cancelled, disposed, or paused for Wi-Fi. */
  #stopped(active: Active): boolean {
    return active.cancelled || active.pausing || this.#disposed;
  }

  #interrupt(active: Active, message: string): void {
    if (active.cancelled) return;
    this.#endSession(active.sessionId);
    this.#dispatch(DownloadEvent.Interrupted({ id: active.id, error: message, resume: null }));
  }

  /** Starts the download's session; interrupts the download and answers null when it cannot. */
  async #openSession(download: DownloadRecord, active: Active): Promise<StartedPlayback | null> {
    const opened = await this.#runSdk(
      Downloads.start({
        profileId: download.profileId,
        deviceId: this.#options.deviceId,
        deviceName: Option.some(this.#options.deviceName),
        titleId: download.titleId,
        episodeId: Option.fromNullishOr(download.episodeId),
        fileId: Option.fromNullishOr(download.fileId),
        capabilities: IOS_CAPABILITIES,
      }),
    );

    if (opened === null || Result.isFailure(opened)) {
      this.#interrupt(active, opened === null ? SERVER_UNAVAILABLE : failureLine(opened.failure));

      return null;
    }

    active.sessionId = opened.success.sessionId;
    this.#dispatch(
      DownloadEvent.SessionStarted({ id: download.id, sessionId: opened.success.sessionId }),
    );

    // Removed or paused while the session started: nothing else will end it.
    if (this.#stopped(active)) {
      this.#endSession(opened.success.sessionId);

      return null;
    }

    return opened.success;
  }

  /** `started` with a fresh token, or as it was when the renewal failed (the next call says why). */
  async #renewed(started: StartedPlayback): Promise<StartedPlayback> {
    const renewed = await this.#runSdk(Downloads.renew(started));

    return renewed !== null && Result.isSuccess(renewed) ? renewed.success : started;
  }

  /**
   * Asks the media service until the download is ready there, one question every few seconds;
   * null when the run stopped, the download did not fit, or it was interrupted.
   */
  async #prepare(
    download: DownloadRecord,
    active: Active,
    state: Preparation,
  ): Promise<{ readonly started: StartedPlayback; readonly ready: DownloadReady } | null> {
    if (this.#stopped(active)) return null;
    const opened = state.started ?? (await this.#openSession(download, active));

    if (opened === null) return null;

    const started =
      state.renew || opened.tokenExpiresAt - Date.now() < RENEW_BEFORE_MS
        ? await this.#renewed(opened)
        : opened;

    const answer = await this.#runSdk(
      Downloads.prepare(started, IOS_CAPABILITIES, download.quality, Option.none()),
    );

    if (this.#stopped(active)) return null;

    if (answer === null || Result.isFailure(answer)) {
      const step =
        answer === null
          ? DownloadStep.Interrupt({ message: SERVER_UNAVAILABLE })
          : afterDownloadFailure(answer.failure);

      if (DownloadStep.$is("Interrupt")(step) || state.restarts >= MAX_RESTARTS) {
        this.#interrupt(
          active,
          DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE,
        );

        return null;
      }

      const restarts = state.restarts + 1;

      if (DownloadStep.$is("Restart")(step)) {
        return this.#prepare(download, active, { started: null, renew: false, restarts });
      }

      if (DownloadStep.$is("Renew")(step)) {
        return this.#prepare(download, active, { started, renew: true, restarts });
      }

      await sleep(BUSY_RETRY_MS);

      return this.#prepare(download, active, { started, renew: false, restarts: state.restarts });
    }

    const response = answer.success;

    if (Predicate.isTagged(response, "Ready")) return { started, ready: response };

    if (
      spaceShortfall(response.estimatedBytes - download.receivedBytes, Paths.availableDiskSpace) > 0
    ) {
      this.#endSession(started.sessionId);
      this.#dispatch(
        DownloadEvent.NoSpace({ id: download.id, totalBytes: response.estimatedBytes }),
      );

      return null;
    }

    this.#dispatch(
      DownloadEvent.Preparing({
        id: download.id,
        progress: response.progress,
        estimatedBytes: response.estimatedBytes,
      }),
    );
    await sleep(PREPARE_EVERY_MS);

    return this.#prepare(download, active, { started, renew: false, restarts: state.restarts });
  }

  /** Keeps the text subtitles and the picture beside the video; returns the tracks kept. */
  async #keepCompanions(
    download: DownloadRecord,
    ready: DownloadReady,
    directory: Directory,
  ): Promise<ReadonlySet<string>> {
    const kept = await Promise.all(
      ready.subtitles.map(async (subtitle) => {
        try {
          await File.downloadFileAsync(
            subtitle.url,
            new File(directory, subtitleFile(subtitle.id)),
            {
              idempotent: true,
            },
          );

          return subtitle.id;
        } catch {
          return null;
        }
      }),
    );

    const picture = artworkUrl(this.#options.mediaUrl, download.artwork, "card");

    if (picture !== undefined) {
      await File.downloadFileAsync(picture, new File(directory, ARTWORK_FILE), {
        idempotent: true,
      }).catch(() => null);
    }

    return new Set(kept.filter(Predicate.isNotNull));
  }

  async #run(download: DownloadRecord, active: Active): Promise<void> {
    // A transfer paused for Wi-Fi, or because the server went away, resumes where it stopped, in
    // the session it ran in: a new session would end the token its saved request carries.
    const saved = download.resume === null ? null : this.#restore(download.id, download.resume);

    if (saved !== null && download.sessionId !== null) {
      active.sessionId = download.sessionId;
      const resumed = await this.#transfer(download.id, active, saved, "resume");

      if (resumed !== "failed" || this.#stopped(active)) return;

      // The saved request no longer works (an expired link, a restarted server): start over.
      this.#endSession(download.sessionId);
      this.#dispatch(DownloadEvent.Waiting({ id: download.id, wifi: false, resume: null }));
    } else {
      // Nothing to resume in it (an app that quit mid-way, a retry): its session ends here.
      this.#endSession(download.sessionId);
    }

    const prepared = await this.#prepare(download, active, {
      started: null,
      renew: false,
      restarts: 0,
    });

    if (prepared === null) return;

    const { started, ready } = prepared;

    if (spaceShortfall(ready.sizeBytes, Paths.availableDiskSpace) > 0) {
      this.#endSession(started.sessionId);
      this.#dispatch(DownloadEvent.NoSpace({ id: download.id, totalBytes: ready.sizeBytes }));

      return;
    }

    const directory = this.#itemDirectory(download.id);

    try {
      directory.create({ intermediates: true, idempotent: true });
    } catch {
      this.#interrupt(active, "This iPhone couldn't save the download.");

      return;
    }

    const kept = await this.#keepCompanions(download, ready, directory);

    this.#artwork.delete(download.id);

    if (this.#stopped(active)) {
      // A later run ends it from the store when this engine is gone.
      if (!this.#disposed) this.#endSession(started.sessionId);

      return;
    }

    this.#dispatch(
      DownloadEvent.Delivering({
        id: download.id,
        delivery: deliveryOf(ready, started, kept),
        playback: {
          episode: started.episode,
          file: started.file,
          resumePositionMs: started.resumePositionMs,
        },
        sessionId: started.sessionId,
      }),
    );

    const destination = new File(directory, videoFile(ready.container === "mov" ? "mov" : "mp4"));

    const outcome = await this.#transfer(
      download.id,
      active,
      File.createDownloadTask(ready.url, destination, {
        onProgress: this.#progressOf(download.id),
      }),
      "start",
    );

    if (outcome === "failed" && !this.#stopped(active)) {
      this.#interrupt(active, SERVER_UNAVAILABLE);
    }
  }

  /** The paused transfer saved in `resume`, or null when it cannot be restored. */
  #restore(id: string, resume: string): DownloadTask | null {
    const state = resumeState(resume);

    if (state === null) return null;

    try {
      return DownloadTask.fromSavable(state, { onProgress: this.#progressOf(id) });
    } catch {
      return null;
    }
  }

  /** Records a transfer's bytes as they arrive, keeping them on disk every few seconds. */
  #progressOf(id: string): (progress: { readonly bytesWritten: number }) => void {
    return ({ bytesWritten }) =>
      this.#dispatch(DownloadEvent.Received({ id, bytes: bytesWritten }), "soon");
  }

  /**
   * Runs a transfer to its end: `done` once the video is kept, `stopped` when it was paused or
   * cancelled, `failed` when the request failed.
   */
  async #transfer(
    id: string,
    active: Active,
    task: DownloadTask,
    how: "start" | "resume",
  ): Promise<"done" | "stopped" | "failed"> {
    active.task = task;
    const unwatch = this.#watchStall(id, active, task);

    try {
      const file = await (how === "resume" ? task.resumeAsync() : task.downloadAsync());

      if (this.#stopped(active)) return "stopped";

      // Paused without being asked to (a saved state iOS no longer honours): it did not finish.
      if (file === null) return "failed";

      this.#dispatch(DownloadEvent.Finished({ id }));
      this.#endSession(active.sessionId);

      return "done";
    } catch {
      return this.#stopped(active) ? "stopped" : "failed";
    } finally {
      unwatch();
      active.task = null;

      // A pause still reads the task's resume data; it releases the task once it has.
      if (!active.pausing) task.release();
    }
  }

  /**
   * Watches a transfer for a server that went away. An iOS background transfer waits for its
   * server instead of failing, so one without progress for a while asks the media service whether
   * it answers; when it does not, the transfer pauses (keeping its resume data) and the download
   * is interrupted (H19). Returns the function that stops watching.
   */
  #watchStall(id: string, active: Active, task: DownloadTask): () => void {
    let lastBytes = -1;
    let since = Date.now();

    const timer = setInterval(() => {
      const bytes =
        this.#snapshot.store.downloads.find((download) => download.id === id)?.receivedBytes ?? 0;

      if (bytes !== lastBytes) {
        lastBytes = bytes;
        since = Date.now();

        return;
      }

      if (Date.now() - since < STALL_AFTER_MS || this.#stopped(active)) return;
      since = Date.now();

      void this.#reachable().then((reachable) =>
        reachable ? undefined : this.#pauseStalled(id, active, task),
      );
    }, STALL_CHECK_MS);

    return () => clearInterval(timer);
  }

  /** Whether the media service answers its health check within a few seconds. */
  async #reachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.#options.mediaUrl}/api/health`, {
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async #pauseStalled(id: string, active: Active, task: DownloadTask): Promise<void> {
    if (this.#stopped(active)) return;
    active.pausing = true;

    const resume = await pauseKeeping(task);

    if (resume === null) this.#endSession(active.sessionId);
    this.#dispatch(DownloadEvent.Interrupted({ id, error: SERVER_UNAVAILABLE, resume }));
  }
}

/** Pauses `task` and reads its resume data, then releases it; null when it cannot resume. */
const pauseKeeping = async (task: DownloadTask): Promise<string | null> => {
  try {
    await task.pauseAsync();

    return JSON.stringify(task.savable());
  } catch {
    task.cancel();

    return null;
  } finally {
    task.release();
  }
};

/** The saved state of a paused transfer, or null when it cannot be read. */
const resumeState = (text: string): DownloadPauseState | null =>
  Option.getOrNull(decodePauseState(text));

/** Whether a failed call never reached the server, so the rest waits too. */
const isUnreachable = (failure: CallError): boolean =>
  Predicate.isTagged(failure, "TransportError");

/** Whether the server refused progress for good: the item or the profile's access is gone. */
const isFinal = (failure: CallError): boolean =>
  Predicate.isTagged(failure, "NotFound") ||
  Predicate.isTagged(failure, "Forbidden") ||
  Predicate.isTagged(failure, "InvalidArgs");

/** H19's line for a failure. */
const failureLine = (failure: CallError | PlaybackCallError): string => {
  const step = afterDownloadFailure(failure);

  return DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE;
};
