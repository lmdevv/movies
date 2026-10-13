/** Runtime configuration of the media service, read once from the environment at startup. */
import { isAbsolute, resolve } from "node:path";

import { DEFAULT_TRICKPLAY_INTERVAL_SECONDS } from "@movies/contracts/trickplay";
import { Config, Context, Duration, Effect, Layer, Option, type Redacted, Schema } from "effect";

/** How the service may use the GPU for video transcoding. */
type HardwareAccelerationMode = "auto" | "qsv" | "vaapi" | "none";

/**
 * How libraries notice changes: file system events, polling, or `auto` (events on local disks,
 * polling on network file systems, which send no events).
 */
type LibraryWatchMode = "auto" | "events" | "poll";

/** Scrub thumbnail generation. */
interface TrickplaySettings {
  /** Whether `trickplay` jobs make thumbnails; when off they fail with a message saying so. */
  readonly enabled: boolean;
  /** Time between thumbnails. */
  readonly interval: Duration.Duration;
  /** Files whose thumbnails are made at once, besides the other jobs. */
  readonly concurrency: number;
}

/** Typed media service settings. */
export interface Interface {
  readonly port: number;
  /** Address the HTTP server listens on; all interfaces when unset. */
  readonly host: Option.Option<string>;
  /** Origin and path prefix clients use to reach this service, without a trailing slash. */
  readonly mediaBaseUrl: string;
  /** Absolute, approved library mounts. Scans and playback never leave them. */
  readonly libraryRoots: ReadonlyArray<string>;
  /** Absolute folder for service state, such as the metadata and keyframe caches. */
  readonly dataDir: string;
  /** Absolute folder for disposable HLS output. Each stream session owns a subfolder. */
  readonly transcodeDir: string;
  /** Absolute folder for nightly backups. */
  readonly backupDir: string;
  /** Archives older than this are pruned after a new backup succeeds. */
  readonly backupRetention: Duration.Duration;
  /** Admin key of the self-hosted Convex deployment, for `convex export` and `convex import`. */
  readonly convexAdminKey: Option.Option<Redacted.Redacted>;
  /** The deployed `@movies/backend` package, whose Convex CLI backs up and restores. */
  readonly convexBackendDir: Option.Option<string>;
  /** Shared HMAC secret Convex signs playback tokens with: base64url of at least 32 bytes. */
  readonly playbackTokenSecret: Redacted.Redacted;
  /** TMDB API key or read access token. Without it the TMDB plugin reports itself unavailable. */
  readonly tmdbApiKey: Option.Option<Redacted.Redacted>;
  /** OMDb API key for IMDb, Rotten Tomatoes, and Metacritic scores. Without it titles keep TMDB's. */
  readonly omdbApiKey: Option.Option<Redacted.Redacted>;
  /** OTLP/HTTP collector base URL. Telemetry export is off without it. */
  readonly otlpEndpoint: Option.Option<string>;
  /** Convex deployment URL; used once the service subscribes to Convex. */
  readonly convexUrl: Option.Option<string>;
  /** The Convex URL browsers use, for the web app's content security policy. */
  readonly convexPublicUrl: Option.Option<string>;
  /** Restricted Convex login of the media service. */
  readonly mediaServiceApiKey: Option.Option<Redacted.Redacted>;
  /** Folder holding the built web app, served with a single-page-app fallback. */
  readonly webDistDir: Option.Option<string>;
  /** Upper bound on simultaneous video transcodes (hardware and software). */
  readonly maxConcurrentTranscodes: number;
  /** Upper bound on simultaneous HLS streams that copy the video (remux and audio-only). */
  readonly maxConcurrentRemuxes: number;
  readonly hardwareAcceleration: HardwareAccelerationMode;
  /** DRM render node used for Intel Quick Sync. */
  readonly qsvDevice: string;
  /** DRM render node used for VA-API. */
  readonly vaapiDevice: string;
  /** A stream session with no requests for this long is closed and its segments deleted. */
  readonly streamIdleTimeout: Duration.Duration;
  /**
   * How far a stream's ffmpeg may run ahead of the furthest segment its player asked for before it
   * pauses; it continues once the player is within half of this.
   */
  readonly streamBufferAhead: Duration.Duration;
  /** Free space `TRANSCODE_DIR` must keep before a new HLS session starts. */
  readonly minFreeTranscodeBytes: number;
  /** Interval of the authoritative library reconciliation that backs up file watching. */
  readonly reconcileInterval: Duration.Duration;
  readonly trickplay: TrickplaySettings;
  readonly libraryWatch: LibraryWatchMode;
  /** How often polled library folders are checked for changes. */
  readonly libraryPollInterval: Duration.Duration;
  /** Longest an ffprobe probe of one file may run. */
  readonly probeTimeout: Duration.Duration;
  /** Longest a keyframe scan (ffprobe reading every packet) of one file may run. */
  readonly keyframeScanTimeout: Duration.Duration;
  /** Size the caches under `DATA_DIR` (provider responses, indexes, subtitles, artwork) are pruned to. */
  readonly cacheMaxBytes: number;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

/** The media service configuration. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MediaConfig") {}

const MEBIBYTE = 1024 * 1024;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** One thumbnail a second at most, one every ten minutes at least. */
const TrickplayIntervalSeconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }));

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(path));

const withoutTrailingSlash = (url: URL): string =>
  `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

/** Reads the configuration from the active `ConfigProvider` (environment variables by default). */
export const layer: Layer.Layer<Service, Config.ConfigError> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(4300));
    const host = yield* Config.option(Config.NonEmptyString("HOST"));
    const mediaBaseUrl = yield* Config.URL("MEDIA_BASE_URL");

    // No approved roots means every library scan is refused; the service still starts.
    const libraryRoots = yield* Config.Array(Schema.NonEmptyString, "LIBRARY_ROOTS").pipe(
      Config.withDefault([]),
    );

    const dataDir = yield* Config.NonEmptyString("DATA_DIR");
    const transcodeDir = yield* Config.NonEmptyString("TRANSCODE_DIR");

    const backupDir = yield* Config.NonEmptyString("BACKUP_DIR").pipe(
      Config.withDefault("/data/backups"),
    );

    const backupRetentionDays = yield* Config.schema(PositiveInt, "BACKUP_RETENTION_DAYS").pipe(
      Config.withDefault(14),
    );

    const convexAdminKey = yield* Config.option(Config.Redacted("CONVEX_SELF_HOSTED_ADMIN_KEY"));
    const convexBackendDir = yield* Config.option(Config.NonEmptyString("CONVEX_BACKEND_DIR"));
    const playbackTokenSecret = yield* Config.Redacted("PLAYBACK_TOKEN_SECRET");
    const tmdbApiKey = yield* Config.option(Config.Redacted("TMDB_API_KEY"));
    const omdbApiKey = yield* Config.option(Config.Redacted("OMDB_API_KEY"));
    const otlpEndpoint = yield* Config.option(Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT"));
    const convexUrl = yield* Config.option(Config.URL("CONVEX_URL"));
    const convexPublicUrl = yield* Config.option(Config.URL("CONVEX_PUBLIC_URL"));
    const mediaServiceApiKey = yield* Config.option(Config.Redacted("MEDIA_SERVICE_API_KEY"));
    const webDistDir = yield* Config.option(Config.NonEmptyString("WEB_DIST_DIR"));

    const maxConcurrentTranscodes = yield* Config.schema(
      PositiveInt,
      "MAX_CONCURRENT_TRANSCODES",
    ).pipe(Config.withDefault(3));

    const maxConcurrentRemuxes = yield* Config.schema(PositiveInt, "MAX_CONCURRENT_REMUXES").pipe(
      Config.withDefault(10),
    );

    const hardwareAcceleration = yield* Config.Literals(
      ["auto", "qsv", "vaapi", "none"],
      "HARDWARE_ACCELERATION",
    ).pipe(Config.withDefault("auto"));

    const qsvDevice = yield* Config.NonEmptyString("QSV_DEVICE").pipe(
      Config.withDefault("/dev/dri/renderD128"),
    );

    const vaapiDevice = yield* Config.NonEmptyString("VAAPI_DEVICE").pipe(
      Config.withDefault("/dev/dri/renderD128"),
    );

    const streamIdleSeconds = yield* Config.schema(PositiveInt, "STREAM_IDLE_SECONDS").pipe(
      Config.withDefault(60),
    );

    const streamBufferAheadSeconds = yield* Config.schema(
      PositiveInt,
      "STREAM_BUFFER_AHEAD_SECONDS",
    ).pipe(Config.withDefault(120));

    const minFreeTranscodeMb = yield* Config.schema(PositiveInt, "MIN_FREE_TRANSCODE_MB").pipe(
      Config.withDefault(2048),
    );

    const reconcileMinutes = yield* Config.schema(PositiveInt, "LIBRARY_RECONCILE_MINUTES").pipe(
      Config.withDefault(360),
    );

    const trickplay = yield* Config.Literals(["on", "off"], "TRICKPLAY").pipe(
      Config.withDefault("on"),
    );

    const trickplayIntervalSeconds = yield* Config.schema(
      TrickplayIntervalSeconds,
      "TRICKPLAY_INTERVAL_SECONDS",
    ).pipe(Config.withDefault(DEFAULT_TRICKPLAY_INTERVAL_SECONDS));

    const trickplayConcurrency = yield* Config.schema(PositiveInt, "TRICKPLAY_CONCURRENCY").pipe(
      Config.withDefault(1),
    );

    const libraryWatch = yield* Config.Literals(["auto", "events", "poll"], "LIBRARY_WATCH").pipe(
      Config.withDefault("auto"),
    );

    const libraryPollSeconds = yield* Config.schema(PositiveInt, "LIBRARY_POLL_SECONDS").pipe(
      Config.withDefault(60),
    );

    const probeTimeoutSeconds = yield* Config.schema(PositiveInt, "PROBE_TIMEOUT_SECONDS").pipe(
      Config.withDefault(60),
    );

    const keyframeScanTimeoutSeconds = yield* Config.schema(
      PositiveInt,
      "KEYFRAME_SCAN_TIMEOUT_SECONDS",
    ).pipe(Config.withDefault(900));

    const cacheMaxMb = yield* Config.schema(PositiveInt, "CACHE_MAX_MB").pipe(
      Config.withDefault(2048),
    );

    const ffmpegPath = yield* Config.NonEmptyString("FFMPEG_PATH").pipe(
      Config.withDefault("ffmpeg"),
    );

    const ffprobePath = yield* Config.NonEmptyString("FFPROBE_PATH").pipe(
      Config.withDefault("ffprobe"),
    );

    return Service.of({
      port,
      host,
      mediaBaseUrl: withoutTrailingSlash(mediaBaseUrl),
      libraryRoots: libraryRoots.map(absolute),
      dataDir: absolute(dataDir),
      transcodeDir: absolute(transcodeDir),
      backupDir: absolute(backupDir),
      backupRetention: Duration.days(backupRetentionDays),
      convexAdminKey,
      convexBackendDir: Option.map(convexBackendDir, absolute),
      playbackTokenSecret,
      tmdbApiKey,
      omdbApiKey,
      otlpEndpoint: Option.map(otlpEndpoint, withoutTrailingSlash),
      convexUrl: Option.map(convexUrl, withoutTrailingSlash),
      convexPublicUrl: Option.map(convexPublicUrl, withoutTrailingSlash),
      mediaServiceApiKey,
      webDistDir: Option.map(webDistDir, absolute),
      maxConcurrentTranscodes,
      maxConcurrentRemuxes,
      hardwareAcceleration,
      qsvDevice,
      vaapiDevice,
      streamIdleTimeout: Duration.seconds(streamIdleSeconds),
      streamBufferAhead: Duration.seconds(streamBufferAheadSeconds),
      minFreeTranscodeBytes: minFreeTranscodeMb * MEBIBYTE,
      reconcileInterval: Duration.minutes(reconcileMinutes),
      trickplay: {
        enabled: trickplay === "on",
        interval: Duration.seconds(trickplayIntervalSeconds),
        concurrency: trickplayConcurrency,
      },
      libraryWatch,
      libraryPollInterval: Duration.seconds(libraryPollSeconds),
      probeTimeout: Duration.seconds(probeTimeoutSeconds),
      keyframeScanTimeout: Duration.seconds(keyframeScanTimeoutSeconds),
      cacheMaxBytes: cacheMaxMb * MEBIBYTE,
      ffmpegPath,
      ffprobePath,
    });
  }),
);
