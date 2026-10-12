/**
 * Puts a negotiated stream into a `<video>` element: direct files and native HLS through `src`,
 * HLS elsewhere through hls.js (loaded on demand, so direct play never downloads it). Failures
 * reach the caller as a `StreamFailure`, keeping the HTTP status the media service answered with
 * so the caller can tell a replaced generation (410) from a lost stream (404) or an expired token
 * (401).
 */
import type { NegotiateResponse } from "@movies/contracts/media-playback";
import type { ErrorData } from "hls.js";

/** Why a stream stopped playing. */
export type StreamFailure =
  /** A media request was answered with this status. */
  | { readonly kind: "http"; readonly status: number }
  /** The browser could not demux or decode what arrived. */
  | { readonly kind: "media" }
  /** A media request got no answer. */
  | { readonly kind: "network" };

/** A stream playing in an element. */
export interface AttachedStream {
  /** How the element plays it. */
  readonly engine: "element" | "hls.js";
  /** Loads another playlist of the same HLS stream (a new generation) and plays from `seconds`. */
  readonly reloadPlaylist: (url: string, seconds: number) => void;
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
): AttachedStream => {
  const onError = (): void => {
    onFailure(element.error?.code === MEDIA_ERR_NETWORK ? { kind: "network" } : { kind: "media" });
  };

  element.addEventListener("error", onError);
  startAt(element, seconds);
  element.src = url;

  return {
    engine: "element",
    reloadPlaylist: (next, from) => {
      startAt(element, from);
      element.src = next;
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

const attachHlsJs = async (
  element: HTMLVideoElement,
  url: string,
  seconds: number,
  onFailure: (failure: StreamFailure) => void,
): Promise<AttachedStream> => {
  // The light build leaves out subtitles, DRM, and alternate audio renditions, which these streams
  // never use: subtitles load as WebVTT `<track>` elements and audio is muxed.
  const { default: Hls } = await import("hls.js/light");
  let mediaRecoveries = 0;

  const hls = new Hls({
    startPosition: seconds,
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

  hls.on(Hls.Events.ERROR, (_event, data) => {
    const failure = failureOf(data, data.type === Hls.ErrorTypes.MEDIA_ERROR);

    if (failure === null) return;

    // A decoder hiccup often recovers in place once; a second one means the path does not work.
    if (failure.kind === "media" && mediaRecoveries === 0) {
      mediaRecoveries += 1;
      hls.recoverMediaError();

      return;
    }

    hls.stopLoad();
    onFailure(failure);
  });

  hls.attachMedia(element);
  hls.loadSource(url);

  return {
    engine: "hls.js",
    reloadPlaylist: (next, from) => {
      hls.stopLoad();
      hls.loadSource(next);
      hls.startLoad(from);
      element.currentTime = from;
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
 * recover from by itself; hls.js retries busy answers (503) on its own first.
 */
export const attachStream = (
  element: HTMLVideoElement,
  stream: Pick<NegotiateResponse, "mode" | "url">,
  seconds: number,
  hlsJs: boolean,
  onFailure: (failure: StreamFailure) => void,
): Promise<AttachedStream> =>
  stream.mode !== "direct" && hlsJs
    ? attachHlsJs(element, stream.url, seconds, onFailure)
    : Promise.resolve(attachToElement(element, stream.url, seconds, onFailure));
