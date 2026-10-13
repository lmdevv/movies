/**
 * The streams a page negotiates, read from the media service's answers as the player
 * receives them.
 */
import { MEDIA_ROUTES, NegotiateResponse } from "@movies/contracts/media-playback";
import type { PlaybackMode } from "@movies/contracts/models/playback";
import type { Page } from "@playwright/test";
import { Option, Schema } from "effect";

// The answer's JSON form, as the SDK reads it (an absent burned-in subtitle arrives as null).
const decodeStream = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(NegotiateResponse)),
);

/**
 * A stream the page negotiated: its mode, its id when it is HLS, the picture subtitle burned into
 * it, and the height of the video it delivers.
 */
export interface NegotiatedStream {
  readonly mode: PlaybackMode;
  readonly streamId: string | undefined;
  readonly burnedInSubtitle: string | undefined;
  readonly height: number;
}

/** Records every stream the page negotiates, in order. */
export const recordStreams = (page: Page): ReadonlyArray<NegotiatedStream> => {
  const streams: Array<NegotiatedStream> = [];

  page.on("response", (response) => {
    if (!response.url().endsWith(MEDIA_ROUTES.negotiate) || !response.ok()) return;

    void response.text().then(
      (body) =>
        Option.map(decodeStream(body), ({ mode, streamId, burnedInSubtitle, video }) =>
          streams.push({ mode, streamId, burnedInSubtitle, height: video.height }),
        ),
      () => Option.none(),
    );
  });

  return streams;
};
