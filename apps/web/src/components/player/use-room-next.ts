/**
 * Moving a watch room on to its next episode, from the player. The server keeps the countdown and
 * carries it out; this hook starts it from the host's player when the credits begin, turns the
 * room's record into the card each member sees, gives the host Play next and the Episodes picker
 * through the room, and opens whatever the room plays next on every member's player, in the room.
 */
import type { DeviceId, EpisodeId, RoomId, TitleId } from "@movies/contracts/ids";
import type { Episode } from "@movies/contracts/models/catalog";
import type { Room } from "@movies/contracts/models/rooms";
import { useCommand } from "@movies/sdk/react";
import { useNavigate } from "@tanstack/react-router";
import { Predicate } from "effect";
import { useCallback, useEffect, useState } from "react";

import { returnTarget } from "@/lib/current-room";
import { describeFailure } from "@/lib/failure";
import { useLatest } from "@/lib/use-latest";

/** What the hook needs from the player. */
export interface RoomNextInput {
  /** The room the player is in, once joined; null outside rooms. */
  readonly room: Room | null;
  readonly deviceId: DeviceId;
  /** This device's part in the room; null outside rooms. */
  readonly role: "host" | "guest" | null;
  /** What the page opened, which the room's media is compared with. */
  readonly page: { readonly titleId: TitleId; readonly episodeId: EpisodeId | undefined };
  /** The episode this player plays, which the host's Play next moves on from. */
  readonly episodeId: EpisodeId | null;
  /** The episode after it, as the host's profile sees it; null after the last or while unknown. */
  readonly nextEpisode: Episode | null;
  /**
   * Whether the host's player is in the credits and playing (or at the end), so the countdown
   * starts, as solo autoplay would start its own.
   */
  readonly credits: boolean;
  /** Whether the host may command the room now: connected, with the server clock known. */
  readonly canCommand: boolean;
}

/** The next-episode card a member sees. */
export type RoomNextCard =
  | {
      readonly kind: "countdown";
      readonly episode: Episode;
      /** The server time the room moves on. */
      readonly nextAt: number;
      /** The host's card acts for everyone; a guest's only closes. */
      readonly role: "host" | "guest";
    }
  | { readonly kind: "unavailable"; readonly episode: Episode; readonly reason: string };

/** The room's next episode for the player. */
export interface RoomNext {
  /** The card to show, or null. */
  readonly card: RoomNextCard | null;
  /**
   * Moves the room on now: the host's Play next, Next button, ⌘K command, and media-session next.
   * Null for guests, after the last episode, and when the next one cannot play.
   */
  readonly playNext: (() => void) | null;
  /** The host's Play next on the card, moving the room on to the episode it counts down to. */
  readonly moveOn: () => void;
  /** The host's Watch credits: cancels the countdown for everyone. */
  readonly cancel: () => void;
  /** Closes the card on this screen only: a guest's Close, or the host's on an unavailable card. */
  readonly close: () => void;
  /** Moves the room to another episode of its show: the host's Episodes picker. Null for guests. */
  readonly pick: ((episodeId: EpisodeId) => void) | null;
}

/** The reason a card gives when the next episode has no file to play. */
const FILE_MISSING = "File missing";

/**
 * The room's next episode for the player. Outside rooms it does nothing and offers nothing, so
 * solo playback keeps its own countdown.
 */
export const useRoomNext = ({
  room,
  deviceId,
  role,
  page,
  episodeId,
  nextEpisode,
  credits,
  canCommand,
}: RoomNextInput): RoomNext => {
  const navigate = useNavigate();
  const startCountdown = useCommand("rooms.startNextCountdown");
  const cancelCountdown = useCommand("rooms.cancelNextCountdown");
  const moveOn = useCommand("rooms.playNext");
  const setMedia = useCommand("rooms.setMedia");
  const readRoom = useCommand("rooms.get");
  const latestRoom = useLatest(room);
  const roomId: RoomId | null = room?.id ?? null;
  const next = room?.next ?? null;
  // Why the host's countdown could not start, for the card; cleared with each episode.
  const [problem, setProblem] = useState<{ readonly from: EpisodeId; readonly reason: string }>();
  // The countdown (by its due time) or unavailable card this screen closed.
  const [closed, setClosed] = useState<string | null>(null);

  const hosting = role === "host" && roomId !== null;
  const nextPlays = nextEpisode?.available === true;

  // The host's player reached the credits: start the room's countdown, once per episode. The
  // server keeps a countdown already running or cancelled, so a reload or a repeat changes nothing.
  const shouldStart =
    hosting &&
    credits &&
    canCommand &&
    next === null &&
    nextPlays &&
    episodeId !== null &&
    room?.episode?.id === episodeId;

  useEffect(() => {
    if (!shouldStart) return;

    // The next episode playing was checked before; a refusal now (its file went missing since, or
    // the room ended) says why in the server's words.
    startCountdown({ roomId, deviceId, fromEpisodeId: episodeId }).catch((cause: unknown) => {
      setProblem({ from: episodeId, reason: describeFailure(cause) });
    });
  }, [shouldStart, roomId, episodeId, deviceId, startCountdown]);

  // Whatever the room plays is what this player opens, in the room: the host's Play next, the
  // countdown, and the host's pick all arrive this way, for the host's own player too.
  const roomTitle = room?.title.id ?? null;
  const roomEpisode = room?.episode?.id;

  useEffect(() => {
    if (roomId === null || roomTitle === null) return;

    if (roomTitle === page.titleId && roomEpisode === page.episodeId) return;

    void navigate({
      ...returnTarget({ id: roomId, titleId: roomTitle, episodeId: roomEpisode ?? null }),
      replace: true,
    });
  }, [roomId, roomTitle, roomEpisode, page.titleId, page.episodeId, navigate]);

  const playNext = useCallback(() => {
    if (roomId === null || episodeId === null) return;

    // From the episode this player shows: a room that already moved on stays where it is.
    moveOn({ roomId, deviceId, fromEpisodeId: episodeId }).catch((cause: unknown) => {
      setProblem({ from: episodeId, reason: describeFailure(cause) });
    });
  }, [roomId, episodeId, deviceId, moveOn]);

  const cancel = useCallback(() => {
    if (roomId === null || episodeId === null) return;

    cancelCountdown({ roomId, deviceId, fromEpisodeId: episodeId }).catch(() => undefined);
  }, [roomId, episodeId, deviceId, cancelCountdown]);

  const pick = useCallback(
    (picked: EpisodeId) => {
      const current = latestRoom.current;

      if (current === null || picked === current.episode?.id) return;

      const switchTo = (revision: number) =>
        setMedia({
          roomId: current.id,
          deviceId,
          revision,
          titleId: current.title.id,
          episodeId: picked,
        });

      // A heartbeat may move the revision on between reading and switching: read it and retry once.
      switchTo(current.clock.revision)
        .catch((cause: unknown) =>
          Predicate.isTagged(cause, "StaleRevision")
            ? readRoom({ roomId: current.id }).then((fresh) => switchTo(fresh.clock.revision))
            : Promise.reject(cause),
        )
        .catch(() => undefined);
    },
    [latestRoom, deviceId, setMedia, readRoom],
  );

  const close = useCallback(() => {
    setClosed(
      next?.status === "pending" ? String(next.nextAt) : `unavailable:${String(episodeId)}`,
    );
  }, [next, episodeId]);

  const card = ((): RoomNextCard | null => {
    if (roomId === null || role === null) return null;

    if (next?.status === "pending") {
      return closed === String(next.nextAt)
        ? null
        : { kind: "countdown", episode: next.episode, nextAt: next.nextAt, role };
    }

    // Only the host learns the next episode cannot play: guests have no countdown to miss.
    if (!hosting || !credits || nextEpisode === null || next !== null) return null;

    if (closed === `unavailable:${String(episodeId)}`) return null;
    const reason = !nextPlays ? FILE_MISSING : problem?.from === episodeId ? problem.reason : null;

    return reason === null ? null : { kind: "unavailable", episode: nextEpisode, reason };
  })();

  return {
    card,
    playNext: hosting && nextPlays ? playNext : null,
    moveOn: playNext,
    cancel,
    close,
    pick: hosting ? pick : null,
  };
};
