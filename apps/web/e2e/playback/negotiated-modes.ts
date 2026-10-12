/**
 * The playback modes a page negotiates, read from the media service's answers as the player
 * receives them.
 */
import { MEDIA_ROUTES } from "@movies/contracts/media-playback";
import { PlaybackMode } from "@movies/contracts/models/playback";
import type { Page } from "@playwright/test";
import { Option, Schema } from "effect";

const decodeMode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ mode: PlaybackMode })),
);

/** Records the playback mode of every stream the page negotiates, in order. */
export const recordModes = (page: Page): ReadonlyArray<PlaybackMode> => {
  const modes: Array<PlaybackMode> = [];

  page.on("response", (response) => {
    if (!response.url().endsWith(MEDIA_ROUTES.negotiate) || !response.ok()) return;

    void response.text().then(
      (body) => Option.map(decodeMode(body), ({ mode }) => modes.push(mode)),
      () => Option.none(),
    );
  });

  return modes;
};
