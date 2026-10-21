/**
 * What a download does after a failed call (H19 · Interrupted): renew the token, start a new
 * session, or stop with the short danger line H19 shows. Pure, over the SDK's tagged failures.
 */
import type { CallError, PlaybackCallError } from "@movies/sdk/effect";
import { Data, Predicate } from "effect";

/** What to do after a download call failed. */
export type DownloadStep = Data.TaggedEnum<{
  /** The token expired: renew it and ask again. */
  Renew: {};
  /** The download session ended (it went idle): start a new one and ask again. */
  Restart: {};
  /** The media service is busy: ask again in a moment. */
  Wait: {};
  /** Stop and show `message` (H19). */
  Interrupt: { readonly message: string };
}>;

/** Constructors and matchers for `DownloadStep`. */
export const DownloadStep = Data.taggedEnum<DownloadStep>();

/** The line for a server that cannot be reached, as H19 shows it. */
export const SERVER_UNAVAILABLE = "Your server is unavailable.";

/** H19's line for each failure the viewer can only retry, by its tag. */
const LINES = [
  { tag: "TransportError", line: SERVER_UNAVAILABLE },
  { tag: "FileResolverUnavailable", line: SERVER_UNAVAILABLE },
  { tag: "InsufficientTranscodeSpace", line: "Your server is out of space for this download." },
  { tag: "TranscodeFailed", line: "Your server couldn't prepare this download." },
  { tag: "UnsupportedPlayback", line: "This can't be downloaded at this quality." },
  { tag: "MediaFileNotFound", line: "This file is missing on your server." },
  { tag: "Conflict", line: "This file is missing on your server." },
] as const;

/** The step after `cause`, a failure of a download call. */
export const afterDownloadFailure = (cause: CallError | PlaybackCallError): DownloadStep => {
  if (Predicate.isTagged(cause, "PlaybackTokenInvalid")) {
    return Predicate.hasProperty(cause, "reason") && cause.reason === "expired"
      ? DownloadStep.Renew()
      : DownloadStep.Restart();
  }

  if (Predicate.isTagged(cause, "PlaybackSessionEnded")) return DownloadStep.Restart();

  if (Predicate.isTagged(cause, "TranscodeCapacityReached")) return DownloadStep.Wait();

  const known = LINES.find(({ tag }) => Predicate.isTagged(cause, tag));

  if (known !== undefined) return DownloadStep.Interrupt({ message: known.line });

  // Server failures (a profile that lost access) carry their own wording.
  return DownloadStep.Interrupt({
    message: cause.message === "" ? "Download stopped. Try again." : cause.message,
  });
};
