/**
 * What the web player decides without side effects: whether to offer resuming, and what to do
 * about each way playback can fail, over the SDK's tagged errors and the stream failures
 * `stream-attachment` reports, so the controller only carries them out. Media service failures
 * follow `Playback.recoveryFor`; a file that is gone shows its own calm state.
 */
import { PlaybackApiError } from "@movies/contracts/media-playback";
import type { CallError, PlaybackCallError } from "@movies/sdk/effect";
import { Playback } from "@movies/sdk/effect";
import { Data, Match, Schema } from "effect";

import type { StreamFailure } from "./stream-attachment";

/** Saved positions shorter than this start from the beginning instead of asking to resume. */
const MIN_RESUME_MS = 10_000;

/**
 * Whether to ask "Resume or start over?" for a saved position. A few seconds in (a peek, or a
 * session that ended before its first progress report) is nothing worth resuming.
 */
export const offersResume = (resumePositionMs: number): boolean =>
  resumePositionMs >= MIN_RESUME_MS;

/** Where playback ends up when it cannot continue. */
export type PlaybackStop = Data.TaggedEnum<{
  /** The file was moved, renamed, or its drive is offline. */
  Missing: {};
  /** No playback path works on this device. */
  Unsupported: {};
  /** Anything else; `message` is safe to show. */
  Failed: { readonly message: string };
}>;

/** Constructors and matchers for `PlaybackStop`. */
export const PlaybackStop = Data.taggedEnum<PlaybackStop>();

/** What to do next after a failure. */
export type PlaybackStep = Data.TaggedEnum<{
  Stop: { readonly stop: PlaybackStop };
  /** Load the stream's current HLS generation at the same position. */
  ReloadPlaylist: {};
  /** Negotiate a new stream at the same position, renewing the token when it is close to expiry. */
  Renegotiate: { readonly afterMs: number };
  /** Drop the failed path and negotiate the next one, telling the viewer. */
  TryAnotherWay: {};
  /** Start a new playback session at the same position. */
  NewSession: {};
}>;

/** Constructors and matchers for `PlaybackStep`. */
export const PlaybackStep = Data.taggedEnum<PlaybackStep>();

/** How long to wait before asking a busy media service again. */
export const RETRY_LATER_MS = 2_000;

/** The message for failures the viewer can only retry. */
export const STOPPED_MESSAGE = "Playback stopped. Try again in a moment.";

const stopWith = (stop: PlaybackStop): PlaybackStep => PlaybackStep.Stop({ stop });

const failed = (message: string): PlaybackStep => stopWith(PlaybackStop.Failed({ message }));

/**
 * The step after starting a session failed. `playback.createSession` reports files that are all
 * missing from disk as `Conflict`; it has no other conflict.
 */
export const afterSessionFailure = (error: CallError): PlaybackStep =>
  Match.valueTags(error, {
    Conflict: () => stopWith(PlaybackStop.Missing()),
    TransportError: () => failed("Can't reach the server. Check the connection."),
    ProtocolError: () => failed(STOPPED_MESSAGE),
    Unauthenticated: ({ message }) => failed(message),
    Forbidden: ({ message }) => failed(message),
    NotFound: ({ message }) => failed(message),
    InvalidArgs: ({ message }) => failed(message),
    Expired: ({ message }) => failed(message),
    StaleRevision: () => failed(STOPPED_MESSAGE),
    RateLimited: () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    Internal: () => failed(STOPPED_MESSAGE),
  });

const recoveryStep = (error: PlaybackCallError): PlaybackStep =>
  Match.value(Playback.recoveryFor(error)).pipe(
    Match.when("reload-playlist", () => PlaybackStep.ReloadPlaylist()),
    Match.when("renegotiate", () => PlaybackStep.Renegotiate({ afterMs: 0 })),
    Match.when("renew-token", () => PlaybackStep.Renegotiate({ afterMs: 0 })),
    Match.when("new-session", () => PlaybackStep.NewSession()),
    Match.when("retry-later", () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS })),
    Match.when("unsupported", () => stopWith(PlaybackStop.Unsupported())),
    Match.when("fail", () => failed(STOPPED_MESSAGE)),
    Match.exhaustive,
  );

const isPlaybackApiError = Schema.is(PlaybackApiError);

/**
 * The step after a media service playback request failed, or the Convex call renewing its token
 * did.
 */
export const afterPlaybackFailure = (error: PlaybackCallError | CallError): PlaybackStep => {
  if (isPlaybackApiError(error)) {
    return Match.value(error).pipe(
      Match.tag("MediaFileNotFound", () => stopWith(PlaybackStop.Missing())),
      Match.orElse(recoveryStep),
    );
  }

  // Renewing the token fails with `Conflict` or `NotFound` once the session ended elsewhere.
  return Match.value(error).pipe(
    Match.tags({
      TransportError: recoveryStep,
      ProtocolError: recoveryStep,
      Conflict: () => PlaybackStep.NewSession(),
      NotFound: () => PlaybackStep.NewSession(),
    }),
    Match.orElse(afterSessionFailure),
  );
};

/** The step after a playing stream failed, from the HTTP status of the request that failed. */
export const afterStreamFailure = (failure: StreamFailure): PlaybackStep => {
  if (failure.kind === "media") return PlaybackStep.TryAnotherWay();

  if (failure.kind === "network") return PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS });

  switch (failure.status) {
    case 410:
      return PlaybackStep.ReloadPlaylist();
    case 401:
    case 404:
      return PlaybackStep.Renegotiate({ afterMs: 0 });
    case 403:
      return failed(STOPPED_MESSAGE);
    default:
      return PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS });
  }
};
