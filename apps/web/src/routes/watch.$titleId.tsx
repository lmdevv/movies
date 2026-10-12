import { EpisodeId, RoomId, TitleId } from "@movies/contracts/ids";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { PlayerScreen } from "@/components/player/player-screen";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

const decodeTitleId = Schema.decodeSync(TitleId);

const WatchSearch = Schema.Struct({
  /** The episode to play; omit for a movie or a show's next episode. */
  episodeId: Schema.optionalKey(EpisodeId),
  /** `0` plays from the beginning; `resume` resumes without asking; omitted asks. */
  start: Schema.optionalKey(Schema.Literals(["0", "resume"])),
  /** The watch room this device plays in. */
  room: Schema.optionalKey(RoomId),
  /** `1` opens Watch together once playback runs. */
  together: Schema.optionalKey(Schema.Literal("1")),
});

/**
 * Playback of a movie or episode: `/watch/<titleId>?episodeId=…&start=0`, with `room=<roomId>` to
 * watch together. A remount starts a new playback session.
 */
export const Route = createFileRoute("/watch/$titleId")({
  params: {
    parse: (raw) => ({ titleId: decodeTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  validateSearch: Schema.toStandardSchemaV1(WatchSearch),
  head: () => ({ meta: [{ title: "Watch · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <RequireProfile>
        <WatchPage />
      </RequireProfile>
    </RequireSignedIn>
  ),
});

function WatchPage() {
  const { titleId } = Route.useParams();
  const search = Route.useSearch();

  return (
    <PlayerScreen
      // A new title or episode is a new session; a room joined or left keeps the stream.
      key={`${titleId}:${search.episodeId ?? ""}`}
      titleId={titleId}
      episodeId={search.episodeId}
      start={search.start}
      roomId={search.room}
      together={search.together === "1"}
    />
  );
}
