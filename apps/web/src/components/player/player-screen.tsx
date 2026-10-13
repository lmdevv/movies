/**
 * The player: one `<video>` element, the playback controller behind it, and every state Paper's
 * 07 Playback and 08 Join watching pages draw around it. The frame renders at once over the
 * title's backdrop; the stream fills it when it arrives.
 *
 * Rooms: a room in the URL is joined first, then the stream starts at the room's live position and
 * the SDK's room engine keeps it there. The host controls the timeline as anyone controls their own
 * player (the engine publishes the changes); guests see the timeline but cannot move it, and the
 * server refuses them if they try. Leaving the room keeps the stream playing on its own.
 */
import { targetPosition } from "@movies/contracts/clock";
import { DRIFT_THRESHOLDS } from "@movies/contracts/clock";
import type { EpisodeId, RoomId, TitleId } from "@movies/contracts/ids";
import type { Room } from "@movies/contracts/models/rooms";
import { EpochMillis, Milliseconds } from "@movies/contracts/units";
import { Playback } from "@movies/sdk/effect";
import { useCommand, useCommandQuery, useMoviesRuntime, useRoomSync } from "@movies/sdk/react";
import { ChapterPopover } from "@movies/ui/components/chapter-popover";
import { CommandMenu } from "@movies/ui/components/command-menu";
import { PlayerButton, PlayerControls, TracksGlyph } from "@movies/ui/components/player-controls";
import { RoomPanel } from "@movies/ui/components/room-panel";
import { TrackPopover } from "@movies/ui/components/track-popover";
import type { TrackOption } from "@movies/ui/components/track-popover";
import { useKeymap } from "@movies/ui/lib/use-keymap";
import { cn } from "@movies/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Effect, Fiber, Result, Stream } from "effect";
import {
  ArrowLeftIcon,
  CastIcon,
  InfoIcon,
  ListVideoIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useCommandRoot } from "@/commands";
import type { PlayerCommands } from "@/commands/playback";
import { PlayerCommandsContext } from "@/commands/playback";
import { artworkUrl } from "@/lib/artwork";
import { deviceName, loadDeviceId } from "@/lib/device-storage";
import { toastFailure } from "@/lib/failure";
import { copyText } from "@/lib/secure-context";
import { episodeCode } from "@/lib/format";
import { playerKeymap } from "@/lib/keymap";
import { audioTrackLabel, subtitleTrackLabel } from "@/lib/media-facts";
import { volumeIsSettable } from "@/playback/browser-support";
import { PlaybackPhase, StartChoice } from "@/playback/playback-controller";
import type { PlaybackRequest } from "@/playback/playback-controller";
import { castImage } from "@/casting/cast-playback";
import { localOnly } from "@/casting/cast-profile";
import type { CastItem } from "@/casting/cast-profile";
import { useAirPlay, useRemotePlayback } from "@/casting/system-targets";
import { useCast, useRemoteState } from "@/casting/use-cast";
import { PlaybackStop } from "@/playback/playback-policy";
import { chapterAt, useScrubbing } from "@/playback/scrubbing";
import { useMediaSession } from "@/playback/use-media-session";
import { usePictureInPicture } from "@/playback/use-picture-in-picture";
import { useMediaState, usePlayback } from "@/playback/use-playback";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

import { AUTOPLAY_COUNTDOWN, AUTOPLAY_VIDEO_FRAME, AutoplayNext } from "./autoplay-next";
import { CastMenu, CastingState } from "./cast-menu";
import {
  PhoneControls,
  PhoneRoomDetails,
  PhoneRoomVideoChrome,
  PhoneSubtitlesButton,
  TrackPill,
} from "./phone-player";
import {
  Buffering,
  PlaybackStopped,
  PreparingStream,
  PressPlay,
  ResumePrompt,
  TryingAnotherWay,
} from "./player-states";
import { roomMembers } from "./room-members";
import {
  HostLeft,
  RoomChip,
  RoomDenied,
  StartRoomDialog,
  SyncingToHost,
  WaitingForHost,
} from "./room-states";
import { hostGone } from "./room-members";
import { StreamInfo } from "./stream-info";
import { useControlsVisible, useFullscreen, usePlayerLayout } from "./use-player-frame";
import { useWatchRoom } from "./use-watch-room";

/** Seconds of buffer that count as a full buffering ring. */
const BUFFER_TARGET_SECONDS = 4;

/** A stall shorter than this shows no buffering ring. */
const BUFFERING_GRACE_MS = 400;

/** How long a keyboard seek shows its thumbnail. */
const KEY_PREVIEW_MS = 1_200;

/** The volume keys move by this much. */
const VOLUME_STEP = 0.1;

const OFF = "off";

/** Where the start of an episode's credits is assumed to be: its last tenth, at most 30 s. */
const creditsSeconds = (duration: number): number => Math.min(30, duration * 0.1);

/** What the player was asked to play. */
export interface PlayerScreenProps {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | undefined;
  /** `0` starts at the beginning; `resume` resumes without asking. */
  readonly start: "0" | "resume" | undefined;
  /** The watch room to join, from the URL. */
  readonly roomId: RoomId | undefined;
  /** Open Watch together once playback runs, as the title page asks. */
  readonly together: boolean;
}

const startChoice = (start: PlayerScreenProps["start"]): StartChoice => {
  if (start === "0") return StartChoice.Beginning();

  return start === "resume" ? StartChoice.Resume() : StartChoice.Ask();
};

/** The player's URL search when it stays on the same stream: playback continues where it is. */
interface WatchSearch {
  readonly episodeId?: EpisodeId;
  readonly room?: RoomId;
  readonly start: "resume";
}

/** The player's URL search for `episodeId` in `room`. */
const watchSearch = (episodeId: EpisodeId | undefined, room: RoomId | undefined): WatchSearch => {
  if (episodeId === undefined)
    return room === undefined ? { start: "resume" } : { room, start: "resume" };

  return room === undefined ? { episodeId, start: "resume" } : { episodeId, room, start: "resume" };
};

/** A room's invite link. */
const roomLink = (id: RoomId): string => `${window.location.origin}/r/${id}`;

/** True after `value` has stayed true for `ms`. */
const useSettled = (value: boolean, ms: number): boolean => {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!value) {
      setSettled(false);

      return undefined;
    }

    const timer = setTimeout(() => setSettled(true), ms);

    return () => clearTimeout(timer);
  }, [value, ms]);

  return value && settled;
};

/** The player screen. */
export function PlayerScreen({ titleId, episodeId, start, roomId, together }: PlayerScreenProps) {
  const { profile, profiles } = useActiveProfile();
  const scopes = useScopes();
  const navigate = useNavigate();
  const runtime = useMoviesRuntime();
  const layout = usePlayerLayout();
  const deviceId = useMemo(() => loadDeviceId(), []);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  // The stream belongs to the room the page opened with; starting or leaving one later keeps it.
  const [openedRoom] = useState(roomId ?? null);
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId });
  const detail = title.status === "success" ? title.data : null;
  const createRoom = useCommand("rooms.create");
  const leaveRoom = useCommand("rooms.leave");
  const endRoom = useCommand("rooms.end");

  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [panel, setPanel] = useState(true);
  const [creditsDismissed, setCreditsDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [brightness, setBrightness] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const [keyPreview, setKeyPreview] = useState<number | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [startDialog, setStartDialog] = useState<{ readonly roomId: RoomId | null } | null>(null);
  const [wantsTogether, setWantsTogether] = useState(together);
  const canSetVolume = useMemo(() => volumeIsSettable(), []);

  const watch = useWatchRoom(roomId ?? null, profile.id, deviceId);
  const roomRef = useRef<Room | null>(null);

  roomRef.current = watch?.room ?? null;

  // Leaving the room the stream belongs to drops it from the URL; the stream plays on alone.
  const leftRoom = openedRoom !== null && roomId === undefined;
  const joined = openedRoom === null || leftRoom || watch?.join.status === "joined";
  const roomReady = openedRoom === null || leftRoom || (joined && watch?.room !== null);
  const roomRecord = watch?.room ?? null;

  const request = useMemo((): PlaybackRequest | null => {
    if (!roomReady) return null;

    const room = roomRef.current;

    return {
      profileId: profile.id,
      deviceId,
      deviceName: deviceName(),
      titleId: room?.title.id ?? titleId,
      episodeId: room === null ? (episodeId ?? null) : (room.episode?.id ?? null),
      roomId: openedRoom,
      start:
        openedRoom === null
          ? startChoice(start)
          : StartChoice.At({
              positionMs: () => {
                const current = roomRef.current;

                return current === null
                  ? 0
                  : targetPosition(current.clock, EpochMillis.make(Date.now()));
              },
            }),
    };
  }, [roomReady, profile.id, deviceId, titleId, episodeId, openedRoom, start]);

  const playbackKey = [
    request === null ? "waiting" : "ready",
    profile.id,
    titleId,
    episodeId ?? "",
    openedRoom ?? "",
  ].join(":");

  const handle = usePlayback(video, request, playbackKey);
  const controller = handle?.controller ?? null;
  const snapshot = handle?.snapshot ?? null;
  const phase = snapshot?.phase ?? PlaybackPhase.Starting();
  const isPlaying = PlaybackPhase.$is("Playing")(phase);
  const player = controller?.player ?? null;
  // Where the session plays: this element, or a cast device. Commands and the room go here.
  const output = controller?.output ?? null;
  const localMedia = useMediaState(video, player);
  const stream = snapshot?.stream ?? null;
  const started = snapshot?.started ?? null;
  const episode = started?.episode ?? roomRecord?.episode ?? null;
  const titleName = detail?.name ?? roomRecord?.title.name ?? "";
  const artworkKey = episode?.still ?? detail?.artwork.poster ?? null;

  const castItem = useMemo(
    (): CastItem | null =>
      started === null
        ? null
        : {
            title: episode?.name ?? titleName,
            episode:
              episode === null
                ? null
                : {
                    seriesTitle: titleName,
                    season: episode.seasonNumber,
                    episode: episode.episodeNumber,
                  },
            imageUrl: castImage(started, artworkKey),
          },
    [started, episode, titleName, artworkKey],
  );

  const chromecast = useCast(controller, isPlaying, castItem);
  const casting = chromecast.playback;
  const remote = useRemoteState(casting);
  const airplay = useAirPlay(video);
  const remotePlayback = useRemotePlayback(video);
  const pip = usePictureInPicture(video);

  // While a TV plays, the controls show its position and state.
  const media =
    remote === null ? localMedia : { ...localMedia, ...remote, bufferedAheadSeconds: 0 };

  // The room engine starts once the stream shows frames, so it never drives an empty element.
  const engine = useRoomSync(
    isPlaying && joined ? output : null,
    roomId === undefined || !joined ? null : { roomId, deviceId },
  );

  const sync = engine !== null && Result.isSuccess(engine) ? engine.success : null;
  const room = roomRecord;

  const duration = stream?.durationSeconds ?? (started?.file.probe.durationMs ?? 0) / 1000;
  const position = scrub ?? media.positionSeconds;
  const inRoom = roomId !== undefined && room !== null && joined;
  const host = inRoom && room.hostDeviceId === deviceId;
  const guest = inRoom && !host;
  const controlsTimeline = !guest;
  const hostName = room?.hostProfileName ?? "The host";

  const heading =
    episode === null ? titleName : `${titleName} ${episodeCode(episode)} ${episode.name}`;

  const next = useCommandQuery(
    "playback.nextEpisode",
    episode === null ? "skip" : { profileId: profile.id, episodeId: episode.id },
  );

  const nextEpisode = next.status === "success" ? next.data : null;

  const backToDetails = useCallback(() => {
    void navigate({ to: "/title/$titleId", params: { titleId } });
  }, [navigate, titleId]);

  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(frame, video);

  const seekTo = useCallback(
    (seconds: number) => {
      if (output === null || !controlsTimeline) return;

      setScrub(null);
      output.seek(Math.max(0, Math.min(duration, seconds)) * 1000);
    },
    [output, controlsTimeline, duration],
  );

  const skip = useCallback(
    (by: number) => seekTo(media.positionSeconds + by),
    [seekTo, media.positionSeconds],
  );

  const scrubbing = useScrubbing(started);
  const preloadThumbnails = scrubbing.preload;
  const keyPreviewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A keyboard seek shows where it landed on the scrubber for a moment.
  const skipByKey = useCallback(
    (by: number) => {
      if (!controlsTimeline) return;
      const target = Math.max(0, Math.min(duration, media.positionSeconds + by));

      skip(by);
      preloadThumbnails();
      setKeyPreview(target);
      clearTimeout(keyPreviewTimer.current);
      keyPreviewTimer.current = setTimeout(() => setKeyPreview(null), KEY_PREVIEW_MS);
    },
    [controlsTimeline, duration, media.positionSeconds, skip, preloadThumbnails],
  );

  useEffect(() => () => clearTimeout(keyPreviewTimer.current), []);

  const currentChapter = chapterAt(scrubbing.chapters, media.positionSeconds);

  const togglePlay = useCallback(() => {
    if (output === null || !controlsTimeline) return;

    if (snapshot?.needsGesture === true && casting === null) {
      controller?.resumeWithGesture();

      return;
    }

    if (output.isPaused()) void output.play().catch(() => undefined);
    else output.pause();
  }, [output, controlsTimeline, snapshot?.needsGesture, controller, casting]);

  const setVolume = useCallback(
    (value: number) => {
      if (casting !== null) {
        casting.player.setVolume(value);

        return;
      }

      if (video === null) return;

      video.volume = Math.min(1, Math.max(0, value));
      video.muted = false;
    },
    [video, casting],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      if (casting !== null) casting.player.setMuted(muted);
      else if (video !== null) video.muted = muted;
    },
    [video, casting],
  );

  // Audio and subtitle choices from the file and the negotiated stream.
  const audioOptions = useMemo(
    (): ReadonlyArray<TrackOption> =>
      (started?.file.probe.audio ?? []).map((track, index) => ({
        id: String(track.index),
        label: audioTrackLabel(track, index),
      })),
    [started],
  );

  const subtitleOptions = useMemo(
    (): ReadonlyArray<TrackOption> => [
      { id: OFF, label: "Off" },
      ...(stream?.subtitles ?? [])
        .filter((track) => track.url !== undefined)
        .map((track, index) => ({ id: track.id, label: subtitleTrackLabel(track, index) })),
    ],
    [stream],
  );

  const subtitleId = snapshot?.subtitleId ?? OFF;

  const audioId =
    snapshot?.audioStreamIndex === null || snapshot === null
      ? ""
      : String(snapshot.audioStreamIndex);

  const lastSubtitle = useRef<string | null>(null);

  const selectSubtitle = useCallback(
    (id: string) => {
      if (id !== OFF) lastSubtitle.current = id;
      controller?.selectSubtitle(id === OFF ? null : id);
    },
    [controller],
  );

  const toggleSubtitles = useCallback(() => {
    if (subtitleId !== OFF) {
      selectSubtitle(OFF);

      return;
    }

    const choice = lastSubtitle.current ?? subtitleOptions[1]?.id;

    if (choice !== undefined) selectSubtitle(choice);
  }, [subtitleId, subtitleOptions, selectSubtitle]);

  const selectAudio = useCallback(
    (id: string) => {
      const index = Number(id);

      if (Number.isInteger(index)) controller?.selectAudio(index);
    },
    [controller],
  );

  // Show the chosen subtitle track; the element keeps one text track per <track>. While a TV
  // plays, it shows the subtitles and the paused element shows none.
  const shownSubtitle = casting === null ? subtitleId : null;

  useEffect(() => {
    if (video === null) return;

    for (const track of Array.from(video.textTracks)) {
      track.mode = track.id === shownSubtitle ? "showing" : "disabled";
    }
  }, [video, shownSubtitle, stream]);

  // Rooms.
  const copyLink = useCallback((id: RoomId) => {
    void copyText(roomLink(id)).then(() => toast.success("Invite link copied"), toastFailure);
  }, []);

  const openStartRoom = useCallback(() => {
    if (started === null || output === null) return;

    const positionMs = Milliseconds.make(Math.max(0, output.positionMs()));

    const input = {
      profileId: profile.id,
      deviceId,
      titleId: started.titleId,
      fileId: started.file.id,
      positionMs,
    };

    setStartDialog({ roomId: null });
    createRoom(
      started.episodeId === null ? input : { ...input, episodeId: started.episodeId },
    ).then(
      (created) => setStartDialog({ roomId: created.id }),
      (cause: unknown) => {
        setStartDialog(null);
        toastFailure(cause);
      },
    );
  }, [started, output, createRoom, profile.id, deviceId]);

  useEffect(() => {
    if (!wantsTogether || !isPlaying || roomId !== undefined) return;
    setWantsTogether(false);
    openStartRoom();
  }, [wantsTogether, isPlaying, roomId, openStartRoom]);

  const cancelStartRoom = useCallback(() => {
    const created = startDialog?.roomId ?? null;

    setStartDialog(null);

    if (created !== null) void endRoom({ roomId: created, deviceId }).catch(toastFailure);
  }, [startDialog, endRoom, deviceId]);

  const confirmStartRoom = useCallback(() => {
    const created = startDialog?.roomId ?? null;

    if (created === null) return;

    setStartDialog(null);
    setPanel(true);
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: watchSearch(episodeId, created),
      replace: true,
    });
  }, [startDialog, navigate, titleId, episodeId]);

  const dropRoomFromUrl = useCallback(() => {
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: watchSearch(episodeId, undefined),
      replace: true,
    });
  }, [navigate, titleId, episodeId]);

  const leaveAndStay = useCallback(() => {
    if (roomId === undefined) return;
    void leaveRoom({ roomId, deviceId }).catch(toastFailure);
    dropRoomFromUrl();
  }, [roomId, leaveRoom, deviceId, dropRoomFromUrl]);

  const leaveAndExit = useCallback(() => {
    if (roomId !== undefined) void leaveRoom({ roomId, deviceId }).catch(toastFailure);
    backToDetails();
  }, [roomId, leaveRoom, deviceId, backToDetails]);

  const endAndStay = useCallback(() => {
    if (roomId === undefined) return;
    void endRoom({ roomId, deviceId }).catch(toastFailure);
    dropRoomFromUrl();
  }, [roomId, endRoom, deviceId, dropRoomFromUrl]);

  // Autoplay next: near the end of an episode, outside rooms.
  const remaining = Math.max(0, duration - media.positionSeconds);

  const showNext =
    isPlaying &&
    !inRoom &&
    nextEpisode !== null &&
    !creditsDismissed &&
    duration > 0 &&
    (media.ended || remaining <= creditsSeconds(duration));

  const playNext = useCallback(() => {
    if (nextEpisode === null) return;
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: { episodeId: nextEpisode.id, start: "resume" },
    });
  }, [navigate, nextEpisode, titleId]);

  // The episode before this one in its season, for the system's previous-track button.
  const seasonEpisodes = useCommandQuery(
    "titles.episodes",
    episode === null || inRoom
      ? "skip"
      : {
          profileId: profile.id,
          titleId: started?.titleId ?? titleId,
          seasonNumber: episode.seasonNumber,
        },
  );

  const previousEpisode = (() => {
    if (seasonEpisodes.status !== "success" || episode === null) return null;
    const at = seasonEpisodes.data.findIndex((candidate) => candidate.id === episode.id);

    return at > 0 ? (seasonEpisodes.data[at - 1] ?? null) : null;
  })();

  const playPrevious = useCallback(() => {
    if (previousEpisode === null) return;
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: { episodeId: previousEpisode.id, start: "resume" },
    });
  }, [navigate, previousEpisode, titleId]);

  useMediaSession(
    !isPlaying || castItem === null
      ? null
      : {
          title: castItem.title,
          artist: episode === null ? "" : titleName,
          album: episode === null ? "" : episodeCode(episode),
          artwork: castItem.imageUrl,
          durationSeconds: duration,
          positionSeconds: media.positionSeconds,
          paused: media.paused,
          play: () => {
            if (output?.isPaused() === true) togglePlay();
          },
          pause: () => {
            if (output?.isPaused() === false) togglePlay();
          },
          seekTo,
          previous: previousEpisode === null || inRoom ? null : playPrevious,
          next: nextEpisode === null || inRoom ? null : playNext,
        },
  );

  useEffect(() => {
    if (!showNext) {
      setCountdown(null);

      return undefined;
    }

    const fiber = runtime.runFork(
      Stream.runForEach(
        Playback.autoplayCountdown(AUTOPLAY_COUNTDOWN.totalMs, AUTOPLAY_COUNTDOWN.stepMs),
        (left) => Effect.sync(() => setCountdown(left)),
      ).pipe(Effect.andThen(Effect.sync(playNext))),
    );

    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  }, [showNext, runtime, playNext]);

  useEffect(() => {
    setCreditsDismissed(false);
  }, [episode?.id]);

  // Guests catching up.
  const guestSyncing =
    guest &&
    (sync === null ||
      sync.offset === null ||
      sync.follow === "blocked" ||
      (sync.clock.status === "playing" &&
        (sync.follow === "buffering" ||
          sync.driftMs === null ||
          Math.abs(sync.driftMs) >= DRIFT_THRESHOLDS.seekMs)));

  const members = useMemo(
    () => (room === null ? [] : roomMembers(room, deviceId, guestSyncing, sync?.driftMs ?? null)),
    [room, deviceId, guestSyncing, sync?.driftMs],
  );

  const roomPaused = room !== null && (room.clock.status !== "playing" || hostGone(room));
  const stalled = useSettled(isPlaying && media.buffering, BUFFERING_GRACE_MS);

  const hold =
    !isPlaying ||
    media.paused ||
    info ||
    menu ||
    startDialog !== null ||
    showNext ||
    scrub !== null;

  const controlsVisible = useControlsVisible(frame, hold);

  // Keyboard.
  useKeymap(
    playerKeymap,
    {
      "menu.toggle": () => setMenu((open) => !open),
      "player.toggle": togglePlay,
      "player.toggle-k": togglePlay,
      "player.back-10": () => skipByKey(-10),
      "player.forward-10": () => skipByKey(10),
      "player.back-5": () => skipByKey(-5),
      "player.forward-5": () => skipByKey(5),
      "player.volume-up": () => setVolume((video?.volume ?? 1) + VOLUME_STEP),
      "player.volume-down": () => setVolume((video?.volume ?? 1) - VOLUME_STEP),
      "player.fullscreen": toggleFullscreen,
      "player.mute": () => setMuted(!media.muted),
      "player.subtitles": toggleSubtitles,
      "player.exit": () => {
        if (info) setInfo(false);
        else backToDetails();
      },
    },
    !menu && startDialog === null,
  );

  // Commands the menu offers while the player is open.
  const commands = useMemo(
    (): PlayerCommands => ({
      playing: !media.paused,
      controlsTimeline,
      togglePlay,
      skip,
      toggleFullscreen,
      showStreamInfo: () => setInfo(true),
      subtitles: subtitleOptions,
      subtitleId,
      selectSubtitle,
      audio: audioOptions,
      audioId,
      selectAudio,
      nextEpisode: nextEpisode === null || inRoom ? null : playNext,
      startRoom: inRoom || started === null ? null : openStartRoom,
      room: !inRoom
        ? null
        : {
            copyLink: () => copyLink(roomId),
            leave: host ? endAndStay : leaveAndExit,
            end: host ? endAndStay : null,
          },
    }),
    [
      media.paused,
      controlsTimeline,
      togglePlay,
      skip,
      toggleFullscreen,
      subtitleOptions,
      subtitleId,
      selectSubtitle,
      audioOptions,
      audioId,
      selectAudio,
      nextEpisode,
      inRoom,
      playNext,
      started,
      openStartRoom,
      roomId,
      copyLink,
      host,
      endAndStay,
      leaveAndExit,
    ],
  );

  const root = useCommandRoot({ navigate, query: menuQuery, profile, profiles, scopes });

  // A room link this profile cannot use shows its own page instead of the player.
  if (watch !== null && watch.join.status === "denied") {
    return (
      <RoomDenied
        denial={watch.join.denial}
        switchProfile={() => void navigate({ to: "/profiles" })}
        home={(className) => (
          <button type="button" className={className} onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
        )}
      />
    );
  }

  const backdrop = artworkUrl(
    detail?.artwork.backdrop ?? room?.title.artwork.backdrop ?? null,
    "backdrop",
  );

  const tracks = (trigger: React.ReactElement) => (
    <TrackPopover
      trigger={trigger}
      container={fullscreen ? frame : undefined}
      audio={audioOptions}
      subtitles={subtitleOptions}
      audioId={audioId}
      subtitleId={subtitleId}
      onAudioChange={selectAudio}
      onSubtitleChange={selectSubtitle}
    />
  );

  const chapterMenu = (trigger: React.ReactElement) => (
    <ChapterPopover
      trigger={trigger}
      container={fullscreen ? frame : undefined}
      chapters={scrubbing.chapters}
      currentId={currentChapter?.id ?? null}
      onSelect={(chapter) => seekTo(chapter.startSeconds)}
    />
  );

  // One menu for every way this browser plays elsewhere: Chromecast, AirPlay, its own picker.
  const castTargets = {
    chromecast: chromecast.available
      ? {
          connecting: chromecast.connecting,
          deviceName: casting?.deviceName ?? null,
          unreachable: started !== null && localOnly(started.mediaBaseUrl),
          onConnect: chromecast.connect,
          onDisconnect: chromecast.disconnect,
        }
      : null,
    airplay:
      airplay === null || !airplay.available
        ? null
        : { active: airplay.active, onChoose: airplay.choose },
    otherDevices:
      chromecast.available ||
      airplay !== null ||
      remotePlayback === null ||
      !remotePlayback.available
        ? null
        : { active: remotePlayback.active, onChoose: remotePlayback.choose },
  };

  const canCast =
    castTargets.chromecast !== null ||
    castTargets.airplay !== null ||
    castTargets.otherDevices !== null;

  const castMenu = (trigger: React.ReactElement) => (
    <CastMenu trigger={trigger} container={fullscreen ? frame : undefined} {...castTargets} />
  );

  const scrubProps = {
    describe: scrubbing.describe,
    chapters: scrubbing.chapterStarts,
    preview: keyPreview,
    onPreviewStart: scrubbing.preload,
  };

  const center = (() => {
    const stopped = PlaybackPhase.$is("Stopped")(phase) ? phase.stop : null;

    if (stopped !== null) {
      return PlaybackStop.$match(stopped, {
        Missing: () => (
          <PlaybackStopped
            missing
            title="We can't find this file"
            description="The video file was moved, renamed, or its drive is offline."
            onBack={backToDetails}
            secondary={
              scopes.has("manage") && detail !== null
                ? {
                    label: "Show missing files",
                    onClick: () =>
                      void navigate({
                        to: "/admin/libraries/$libraryId",
                        params: { libraryId: detail.libraryId },
                      }),
                  }
                : undefined
            }
          />
        ),
        Unsupported: () => (
          <PlaybackStopped
            missing={false}
            title="This can't play here"
            description="This device can't play the file in any way the server offers."
            onBack={backToDetails}
          />
        ),
        Failed: ({ message }) => (
          <PlaybackStopped
            missing={false}
            title="Playback stopped"
            description={message}
            onBack={backToDetails}
            secondary={{ label: "Try again", onClick: () => controller?.retry() }}
          />
        ),
      });
    }

    if (PlaybackPhase.$is("Choosing")(phase)) {
      return (
        <ResumePrompt
          titleLabel={heading}
          profileName={profile.name}
          positionMs={phase.resumeAtMs}
          durationMs={started?.file.probe.durationMs ?? 0}
          onResume={() => controller?.choose("resume")}
          onStartOver={() => controller?.choose("beginning")}
        />
      );
    }

    if (PlaybackPhase.$is("Recovering")(phase)) {
      return <TryingAnotherWay positionMs={phase.positionMs} onBack={backToDetails} />;
    }

    if (guest && hostGone(room)) {
      return (
        <HostLeft
          hostName={hostName}
          positionMs={room.clock.positionAtAnchorMs}
          onKeepWatching={() => {
            leaveAndStay();
            // The room paused this player; the click lets it play again on its own.
            controller?.resumeWithGesture();
          }}
          onLeave={leaveAndExit}
        />
      );
    }

    if (guest && (!isPlaying || guestSyncing)) {
      const target = targetPosition(room.clock, EpochMillis.make(Date.now()));
      const blocked = sync?.follow === "blocked" || snapshot?.needsGesture === true;

      return (
        <SyncingToHost
          hostName={hostName}
          targetMs={target}
          progress={
            isPlaying ? Math.min(1, media.bufferedAheadSeconds / BUFFER_TARGET_SECONDS) : 0.2
          }
          onJoin={blocked ? () => controller?.resumeWithGesture() : undefined}
        />
      );
    }

    if (guest && room.clock.status === "buffering") return <WaitingForHost hostName={hostName} />;

    if (!isPlaying) {
      const preparing = PlaybackPhase.$is("Preparing")(phase) ? phase : null;

      return (
        <PreparingStream
          titleLabel={heading}
          startAtMs={preparing?.startAtMs ?? 0}
          progress={preparing?.progress ?? 0.1}
        />
      );
    }

    if (snapshot?.needsGesture === true) {
      return <PressPlay onPlay={() => controller?.resumeWithGesture()} />;
    }

    if (stalled) {
      return <Buffering fraction={media.bufferedAheadSeconds / BUFFER_TARGET_SECONDS} />;
    }

    return null;
  })();

  const showChrome = isPlaying && center === null && !showNext;
  const portraitRoom = layout === "phone-portrait" && inRoom;
  const sidePanel = layout === "desktop" && inRoom && panel;

  const videoElement = (
    <video
      ref={setVideo}
      data-testid="player-video"
      crossOrigin="anonymous"
      playsInline
      x-webkit-airplay="allow"
      poster={backdrop}
      className="size-full bg-dark-bg object-contain"
      style={brightness < 1 ? { filter: `brightness(${String(brightness)})` } : undefined}
      onClick={layout === "desktop" ? togglePlay : undefined}
    >
      {(stream?.subtitles ?? []).flatMap((track, index) =>
        track.url === undefined
          ? []
          : [
              <track
                key={`${track.id}:${track.url}`}
                id={track.id}
                kind="subtitles"
                src={track.url}
                label={subtitleTrackLabel(track, index)}
                {...(track.language === undefined ? {} : { srcLang: track.language })}
              />,
            ],
      )}
    </video>
  );

  const desktopControls = (
    <>
      <header
        className={cn(
          "on-media absolute inset-x-0 top-0 flex h-35 items-start justify-between bg-linear-to-b from-dark-bg/60 to-transparent px-10 py-8 transition-opacity duration-300",
          !controlsVisible &&
            !PlaybackPhase.$is("Choosing")(phase) &&
            "pointer-events-none opacity-0",
        )}
      >
        <div className="flex items-center gap-5">
          <PlayerButton
            aria-label="Back to details"
            onClick={backToDetails}
            className="[&_svg]:size-7"
          >
            <ArrowLeftIcon strokeWidth={1.75} aria-hidden />
          </PlayerButton>
          {inRoom ? (
            <RoomChip paused={roomPaused} watching={hostGone(room) ? undefined : members.length} />
          ) : null}
        </div>
        <div className="flex items-center gap-6">
          {isPlaying && pip !== null && casting === null ? (
            <PlayerButton
              aria-label="Picture in picture"
              aria-pressed={pip.active}
              active={pip.active}
              onClick={pip.toggle}
            >
              <PictureInPicture2Icon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          ) : null}
          {isPlaying && canCast
            ? castMenu(
                <PlayerButton aria-label="Cast" active={casting !== null}>
                  <CastIcon strokeWidth={1.75} aria-hidden />
                </PlayerButton>,
              )
            : null}
          {isPlaying && stream !== null && started !== null ? (
            <PlayerButton
              aria-label="Stream info"
              aria-pressed={info}
              active={info}
              onClick={() => setInfo((open) => !open)}
            >
              <InfoIcon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          ) : null}
        </div>
      </header>
      {info && stream !== null && started !== null ? (
        <StreamInfo
          file={started.file}
          stream={stream}
          bufferedAheadSeconds={media.bufferedAheadSeconds}
          onClose={() => setInfo(false)}
          className="absolute top-21 right-10"
        />
      ) : null}
      {showChrome || (isPlaying && guest && center === null) ? (
        <PlayerControls
          className={cn(
            "absolute inset-x-0 bottom-0 transition-opacity duration-300",
            !controlsVisible && "pointer-events-none opacity-0",
          )}
          title={heading}
          playing={!media.paused}
          position={position}
          duration={duration}
          muted={media.muted}
          locked={guest ? `Only ${hostName} can pause or seek` : undefined}
          roomActive={sidePanel}
          tracks={tracks(
            <PlayerButton aria-label="Audio and subtitles">
              <TracksGlyph />
            </PlayerButton>,
          )}
          chapterList={
            scrubbing.chapters.length === 0 || guest
              ? undefined
              : chapterMenu(
                  <PlayerButton aria-label="Chapters">
                    <ListVideoIcon strokeWidth={1.75} aria-hidden />
                  </PlayerButton>,
                )
          }
          scrub={scrubProps}
          onPlayPause={togglePlay}
          onSeek={(seconds) => setScrub(seconds)}
          onSeekCommit={seekTo}
          onMuteChange={setMuted}
          onNext={nextEpisode === null || inRoom ? undefined : playNext}
          onRoom={inRoom ? () => setPanel((open) => !open) : openStartRoom}
          onFullscreen={toggleFullscreen}
        />
      ) : null}
    </>
  );

  const phoneControls =
    isPlaying && center === null && !showNext ? (
      <div
        className={cn(
          "transition-opacity duration-300",
          !controlsVisible && "pointer-events-none opacity-0",
        )}
      >
        <PhoneControls
          title={heading}
          playing={!media.paused}
          position={position}
          duration={duration}
          brightness={brightness}
          volume={canSetVolume ? (media.muted ? 0 : media.volume) : null}
          locked={guest ? `${hostName} is hosting` : undefined}
          tracks={
            <>
              {tracks(
                <TrackPill
                  icon="subtitles"
                  label={subtitleOptions.find((option) => option.id === subtitleId)?.label ?? "Off"}
                />,
              )}
              {audioOptions.length === 0
                ? null
                : tracks(
                    <TrackPill
                      icon="audio"
                      label={audioOptions.find((option) => option.id === audioId)?.label ?? "Audio"}
                    />,
                  )}
              {scrubbing.chapters.length === 0 || guest
                ? null
                : chapterMenu(
                    <TrackPill
                      icon="chapters"
                      label={currentChapter?.title ?? "Chapters"}
                      aria-label={`Chapters: ${currentChapter?.title ?? "none playing"}`}
                    />,
                  )}
            </>
          }
          onClose={backToDetails}
          onPlayPause={togglePlay}
          onSkip={skip}
          onSeek={(seconds) => setScrub(seconds)}
          onSeekCommit={seekTo}
          scrub={scrubProps}
          onBrightness={setBrightness}
          onVolume={setVolume}
          onRoom={inRoom ? undefined : openStartRoom}
          castMenu={canCast ? castMenu : undefined}
        />
      </div>
    ) : null;

  return (
    <PlayerCommandsContext.Provider value={commands}>
      <div
        ref={setFrame}
        data-testid="player"
        className={cn(
          "fixed inset-0 flex bg-dark-bg text-text select-none",
          portraitRoom ? "flex-col" : "flex-row",
          !controlsVisible && "cursor-none",
        )}
      >
        <div
          className={cn(
            "relative",
            portraitRoom
              ? "mt-[env(safe-area-inset-top)] aspect-video w-full shrink-0"
              : "min-w-0 grow",
          )}
        >
          <div className={cn("absolute inset-0", showNext && AUTOPLAY_VIDEO_FRAME)}>
            {videoElement}
            {casting === null ? null : <CastingState deviceName={casting.deviceName} />}
          </div>
          {portraitRoom ? (
            <PhoneRoomVideoChrome
              hostName={hostName}
              fraction={duration <= 0 ? 0 : Math.min(1, position / duration)}
              onFullscreen={toggleFullscreen}
            />
          ) : layout === "desktop" ? (
            desktopControls
          ) : (
            phoneControls
          )}
          {center}
          {showNext ? (
            <AutoplayNext
              current={heading}
              remainingSeconds={remaining}
              next={nextEpisode}
              countdownMs={countdown ?? AUTOPLAY_COUNTDOWN.totalMs}
              onPlayNext={playNext}
              onWatchCredits={() => setCreditsDismissed(true)}
            />
          ) : null}
        </div>
        {portraitRoom ? (
          <PhoneRoomDetails
            live={!roomPaused}
            position={position}
            duration={duration}
            title={titleName}
            members={members}
            subtitles={tracks(<PhoneSubtitlesButton />)}
            onLeave={host ? endAndStay : leaveAndExit}
          />
        ) : null}
        {sidePanel ? (
          <RoomPanel
            className="shrink-0"
            members={members}
            paused={roomPaused}
            onCopyLink={host ? () => copyLink(roomId) : undefined}
            onEnd={host ? endAndStay : undefined}
            onLeave={host || hostGone(room) ? undefined : leaveAndExit}
          />
        ) : null}
        <StartRoomDialog
          open={startDialog !== null}
          link={
            startDialog?.roomId === null || startDialog === null
              ? null
              : roomLink(startDialog.roomId)
          }
          container={fullscreen ? frame : null}
          onCopy={() => {
            if (startDialog?.roomId != null) copyLink(startDialog.roomId);
          }}
          onCancel={cancelStartRoom}
          onStart={confirmStartRoom}
        />
        <CommandMenu
          open={menu}
          onOpenChange={(open) => {
            setMenu(open);

            if (!open) setMenuQuery("");
          }}
          onQueryChange={(text, page) => {
            if (page.id === "root") setMenuQuery(text);
          }}
          root={root}
        />
      </div>
    </PlayerCommandsContext.Provider>
  );
}
