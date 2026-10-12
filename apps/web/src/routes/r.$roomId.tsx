import { RoomId } from "@movies/contracts/ids";
import { useCommandQuery } from "@movies/sdk/react";
import { CalmState } from "@movies/ui/components/calm-state";
import { Spinner } from "@movies/ui/components/spinner";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Predicate, Schema } from "effect";
import { useEffect } from "react";

import { RoomDenied } from "@/components/player/room-states";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

const decodeRoomId = Schema.decodeSync(RoomId);

/**
 * A room link, `/r/<roomId>`: account holders only. It opens the player in the room, or says why
 * it cannot: the room ended, or the active profile cannot see what it plays.
 */
export const Route = createFileRoute("/r/$roomId")({
  params: {
    parse: (raw) => ({ roomId: decodeRoomId(raw.roomId) }),
    stringify: (params) => ({ roomId: params.roomId }),
  },
  head: () => ({ meta: [{ title: "Watch together · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <RequireProfile>
        <RoomLinkPage />
      </RequireProfile>
    </RequireSignedIn>
  ),
});

const home = (className: string) => (
  <Link to="/" className={className}>
    Go to Home
  </Link>
);

function RoomLinkPage() {
  const { roomId } = Route.useParams();
  const navigate = useNavigate();
  const room = useCommandQuery("rooms.get", { roomId });
  const open = room.status === "success" && room.data.clock.status !== "ended" ? room.data : null;

  useEffect(() => {
    if (open === null) return;

    void navigate({
      to: "/watch/$titleId",
      params: { titleId: open.title.id },
      search:
        open.episode === null ? { room: open.id } : { room: open.id, episodeId: open.episode.id },
      replace: true,
    });
  }, [open, navigate]);

  if (room.status === "success" && room.data.clock.status === "ended") {
    return (
      <RoomDenied
        denial={{ kind: "ended", hostName: room.data.hostProfileName }}
        home={home}
        switchProfile={() => void navigate({ to: "/profiles" })}
      />
    );
  }

  if (room.status === "error") {
    return Predicate.isTagged(room.error, "NotFound") ? (
      <RoomDenied
        denial={{ kind: "household", hostName: null }}
        home={home}
        switchProfile={() => void navigate({ to: "/profiles" })}
      />
    ) : (
      <div className="on-media flex min-h-svh items-center justify-center bg-dark-bg px-6">
        <CalmState title="Can't open this room" description={room.error.message} />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-dark-bg">
      <Spinner className="size-12 text-text" label="Opening the room" />
    </div>
  );
}
