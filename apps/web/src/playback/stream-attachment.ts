/**
 * Puts a negotiated stream into a `<video>` element: direct files and native HLS through `src`,
 * HLS elsewhere through hls.js (loaded on demand, so direct play never downloads it). Failures
 * reach the caller as a `StreamFailure`, keeping the HTTP status the media service answered with
 * so the caller can tell a replaced generation (410) from a lost stream (404) or an expired token
 * (401). What hls.js sees on the way, every segment it loads and every error, recovered or not,
 * reaches the caller's `observe` for the player diagnostics.
 */
import { PlayerObservation } from "@movies/contracts/diagnostics";
import type { NegotiateResponse } from "@movies/contracts/media-playback";
import type { ErrorData, FragLoadedData } from "hls.js";

/** Why a stream stopped playing. */
export type StreamFailure =
  /** A media request was answered with this status. */
  | { readonly kind: "http"; readonly status: number }
  /** The browser could not demux or decode what arrived. */
  | { readonly kind: "media" }
  /** A media request got no answer. */
  | { readonly kind: "network" };

/** Receives what the player saw, for the player diagnostics. */
export type Observe = (observation: PlayerObservation) => void;

/** How long hls.js took to load a media segment, or none for the init segment. */
const fragmentLoaded = ({ frag }: FragLoadedData): PlayerObservation | null => {
  if (frag.sn === "initSegment") return null;
  const { loading, loaded } = frag.stats;

  return PlayerObservation.cases.FragmentLoaded.make({
    segment: Math.max(0, frag.sn),
    durationMs: Math.max(0, Math.round(loading.end - loading.start)),
    firstByteMs: Math.max(0, Math.round(loading.first - loading.start)),
    bytes: Math.max(0, Math.round(loaded)),
  });
};

/** A stream failure in a sentence. */
export const describeFailure = (failure: StreamFailure): string => {
  if (failure.kind === "http")
    return `A media request was answered with HTTP ${String(failure.status)}`;

  return failure.kind === "media"
    ? "The browser could not demux or decode the stream"
    : "A media request got no answer";
};

/** What the element's own failure looks like to the service. */
export const failureObservation = (failure: StreamFailure): PlayerObservation =>
  PlayerObservation.cases.PlayerError.make({
    source: "html-video",
    kind: failure.kind,
    detail: describeFailure(failure),
    fatal: true,
    status: failure.kind === "http" ? failure.status : undefined,
  });

/** An hls.js error as the diagnostics record it, recovered or not. */
const hlsError = (data: ErrorData): PlayerObservation =>
  PlayerObservation.cases.PlayerError.make({
    source: "hls.js",
    kind: data.details.slice(0, 64) || "unknown",
    detail: (data.error.message || data.type).slice(0, 300),
    fatal: data.fatal,
    status: data.response?.code,
  });

/** A stream playing in an element. */
export interface AttachedStream {
  /** How the element plays it. */
  readonly engine: "element" | "hls.js";
  /**
   * Loads another playlist of the same HLS stream (a new generation) at `seconds`, and resolves
   * once the element can play there. The element is left paused: a new source empties it.
   */
  readonly reloadPlaylist: (url: string, seconds: number) => Promise<void>;
  /** Stops loading and frees the element for the next stream. */
  readonly detach: () => void;
}

/** Statuses that mean the stream itself is gone or refused; hls.js would not retry them. */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/** `MediaError.MEDIA_ERR_NETWORK`. */
const MEDIA_ERR_NETWORK = 2;

/**
 * Whether this browser plays HLS through hls.js: Media Source Extensions are present and the
 * browser is not Safari, whose native player handles HLS (and AirPlay) better.
 */
export const usesHlsJs = (mse: boolean): boolean =>
  mse && !/^((?!chrome|android).)*safari/iu.test(navigator.userAgent);

/** Resolves once `element` has data to play at its position. */
const canPlay = (element: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    element.addEventListener(
      "canplay",
      () => {
        resolve();
      },
      { once: true },
    );
  });

/** Sets `seconds` once the element knows the media's duration, as `src` loads start at zero. */
const startAt = (element: HTMLVideoElement, seconds: number): void => {
  if (seconds <= 0) return;

  element.addEventListener(
    "loadedmetadata",
    () => {
      element.currentTime = seconds;
    },
    { once: true },
  );
};

const attachToElement = (
  element: HTMLVideoElement,
  url: string,
  seconds: number,
  onFailure: (failure: StreamFailure) => void,
  observe: Observe,
): AttachedStream => {
  const onError = (): void => {
    const failure: StreamFailure =
      element.error?.code === MEDIA_ERR_NETWORK ? { kind: "network" } : { kind: "media" };

    observe(failureObservation(failure));
    onFailure(failure);
  };

  element.addEventListener("error", onError);
  startAt(element, seconds);
  element.src = url;

  return {
    engine: "element",
    reloadPlaylist: (next, from) => {
      startAt(element, from);
      element.src = next;

      return canPlay(element);
    },
    detach: () => {
      element.removeEventListener("error", onError);
      element.removeAttribute("src");
      element.load();
    },
  };
};

const failureOf = (data: ErrorData, mediaError: boolean): StreamFailure | null => {
  const status = data.response?.code;

  if (status !== undefined && TERMINAL_STATUSES.has(status)) return { kind: "http", status };

  if (!data.fatal) return null;

  if (mediaError) return { kind: "media" };

  return status === undefined || status === 0 ? { kind: "network" } : { kind: "http", status };
};

/**
 * Loads hls.js ahead of the stream that needs it. The player calls this while it negotiates, so
 * the script downloads alongside the request instead of after it; the module loads once.
 */
// The light build leaves out subtitles, DRM, and alternate audio renditions, which these streams
// never use: subtitles load as WebVTT `<track>` elements and audio is muxed.
export const preloadHlsJs = () => import("hls.js/light");

const attachHlsJs = async (
  element: HTMLVideoElement,
  url: string,
  seconds: number,
  onFailure: (failure: StreamFailure) => void,
  observe: Observe,
): Promise<AttachedStream> => {
  const { default: Hls } = await preloadHlsJs();
  let mediaRecoveries = 0;
  /** Where loading starts once the current playlist is parsed. */
  let startFrom = seconds;

  const hls = new Hls({
    // Loading starts by hand once each playlist is parsed: a new generation's playlist starts
    // later in the film, and hls.js would otherwise start it from the first configured position.
    autoStartLoad: false,
    // Fetch the first segment while the init segment and the media source are still being set
    // up; the media service starts encoding it before the playlist is even requested.
    startFragPrefetch: true,
    // One rendition: there is nothing to choose between, so no bandwidth test delays the start.
    testBandwidth: false,
    // A transcode produces segments a little faster than real time; half a minute is plenty.
    maxBufferLength: 30,
    backBufferLength: 30,
    // Segments wait on ffmpeg; the media service answers 503 when one was not produced in time.
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 20_000,
        maxLoadTimeMs: 60_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4_000 },
      },
    },
  });

  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    const loaded = fragmentLoaded(data);

    if (loaded !== null) observe(loaded);
  });

  hls.on(Hls.Events.ERROR, (_event, data) => {
    observe(hlsError(data));
    const failure = failureOf(data, data.type === Hls.ErrorTypes.MEDIA_ERROR);

    if (failure === null) return;

    // A decoder hiccup often recovers in place once; a second one means the path does not work.
    if (failure.kind === "media" && mediaRecoveries === 0) {
      mediaRecoveries += 1;
      observe(
        PlayerObservation.cases.Recovery.make({
          action: "media-error-recovery",
          reason: data.details.slice(0, 120),
        }),
      );
      hls.recoverMediaError();

      return;
    }

    hls.stopLoad();
    onFailure(failure);
  });

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    hls.startLoad(startFrom);
  });

  hls.attachMedia(element);
  hls.loadSource(url);

  return {
    engine: "hls.js",
    reloadPlaylist: (next, from) => {
      hls.stopLoad();
      startFrom = from;
      // A new URL re-creates the MediaSource, which empties the element; loading starts at
      // `from` once the playlist is parsed.
      hls.loadSource(next);

      return canPlay(element);
    },
    detach: () => {
      hls.destroy();
      element.removeAttribute("src");
      element.load();
    },
  };
};

/**
 * Plays `stream` in `element` from `seconds`. `onFailure` hears about failures the stream cannot
 * recover from by itself; hls.js retries busy answers (503) on its own first. `observe` hears
 * the element's failures, and hls.js segment loads, errors, and recoveries.
 */
export const attachStream = (
  element: HTMLVideoElement,
  stream: Pick<NegotiateResponse, "mode" | "url">,
  seconds: number,
  hlsJs: boolean,
  onFailure: (failure: StreamFailure) => void,
  observe: Observe,
): Promise<AttachedStream> =>
  stream.mode !== "direct" && hlsJs
    ? attachHlsJs(element, stream.url, seconds, onFailure, observe)
    : Promise.resolve(attachToElement(element, stream.url, seconds, onFailure, observe));
