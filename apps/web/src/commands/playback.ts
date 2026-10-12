/**
 * Player commands in the menu: play or pause, skip, subtitles and audio as nested lists, stream
 * info, full screen, and the next episode. They exist only while the player is open; the player
 * provides what they act on through `PlayerCommandsContext`.
 */
import type { CommandItem, CommandPage } from "@movies/ui/lib/command-menu";
import type { TrackOption } from "@movies/ui/components/track-popover";
import {
  AudioLinesIcon,
  CaptionsIcon,
  FastForwardIcon,
  InfoIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  SkipForwardIcon,
} from "lucide-react";
import { createContext, useContext, useMemo } from "react";

import { playerKeymap } from "@/lib/keymap";

import type { CommandContribution } from "./contribution";

/** Room actions the player offers while it is in a room. */
export interface PlayerRoomCommands {
  readonly copyLink: () => void;
  readonly leave: () => void;
  /** Ends the room for everyone; null for guests. */
  readonly end: (() => void) | null;
}

/** What the open player lets the menu do. */
export interface PlayerCommands {
  readonly playing: boolean;
  /** Solo viewers and room hosts move the timeline; guests follow it. */
  readonly controlsTimeline: boolean;
  readonly togglePlay: () => void;
  readonly skip: (seconds: number) => void;
  readonly toggleFullscreen: () => void;
  readonly showStreamInfo: () => void;
  readonly subtitles: ReadonlyArray<TrackOption>;
  readonly subtitleId: string;
  readonly selectSubtitle: (id: string) => void;
  readonly audio: ReadonlyArray<TrackOption>;
  readonly audioId: string;
  readonly selectAudio: (id: string) => void;
  /** Plays the next episode now; null for movies and the last episode. */
  readonly nextEpisode: (() => void) | null;
  /** Starts a room for this title; null while in one. */
  readonly startRoom: (() => void) | null;
  /** The room the player is in, or null. */
  readonly room: PlayerRoomCommands | null;
}

/** The open player's commands; null everywhere else. */
export const PlayerCommandsContext = createContext<PlayerCommands | null>(null);

/** The open player's commands, for menu contributions. */
export const usePlayerCommands = (): PlayerCommands | null => useContext(PlayerCommandsContext);

const trackPage = (
  id: string,
  breadcrumb: string,
  options: ReadonlyArray<TrackOption>,
  selected: string,
  select: (id: string) => void,
): CommandPage => ({
  id,
  breadcrumb,
  placeholder: `Search ${breadcrumb.toLowerCase()}…`,
  groups: [
    {
      id: `${id}:options`,
      items: options.map((option): CommandItem => ({
        kind: "action",
        id: `${id}:${option.id}`,
        title: option.label,
        leading: option.id === selected ? { kind: "check" } : undefined,
        perform: () => select(option.id),
      })),
    },
  ],
});

/** The player's group of commands, when the player is open. */
export const usePlaybackCommands = (): CommandContribution => {
  const player = usePlayerCommands();

  return useMemo((): CommandContribution => {
    if (player === null) return { groups: [] };

    const timeline: ReadonlyArray<CommandItem> = player.controlsTimeline
      ? [
          {
            kind: "action",
            id: "player:toggle",
            title: player.playing ? "Pause" : "Play",
            leading: { kind: "icon", icon: player.playing ? PauseIcon : PlayIcon },
            keycaps: playerKeymap.keycaps("player.toggle"),
            perform: player.togglePlay,
          },
          {
            kind: "action",
            id: "player:back",
            title: "Back 10 seconds",
            keywords: ["rewind", "seek"],
            leading: { kind: "icon", icon: RewindIcon },
            keycaps: playerKeymap.keycaps("player.back-10"),
            perform: () => player.skip(-10),
          },
          {
            kind: "action",
            id: "player:forward",
            title: "Forward 10 seconds",
            keywords: ["skip", "seek"],
            leading: { kind: "icon", icon: FastForwardIcon },
            keycaps: playerKeymap.keycaps("player.forward-10"),
            perform: () => player.skip(10),
          },
        ]
      : [];

    const next: ReadonlyArray<CommandItem> =
      player.nextEpisode === null || !player.controlsTimeline
        ? []
        : [
            {
              kind: "action",
              id: "player:next",
              title: "Next episode",
              leading: { kind: "icon", icon: SkipForwardIcon },
              perform: player.nextEpisode,
            },
          ];

    const items: ReadonlyArray<CommandItem> = [
      ...timeline,
      ...next,
      {
        kind: "submenu",
        id: "player:subtitles",
        title: "Subtitles",
        keywords: ["captions", "cc"],
        leading: { kind: "icon", icon: CaptionsIcon },
        page: trackPage(
          "subtitles",
          "Subtitles",
          player.subtitles,
          player.subtitleId,
          player.selectSubtitle,
        ),
      },
      {
        kind: "submenu",
        id: "player:audio",
        title: "Audio",
        keywords: ["language", "track", "dub"],
        leading: { kind: "icon", icon: AudioLinesIcon },
        page: trackPage("audio", "Audio", player.audio, player.audioId, player.selectAudio),
      },
      {
        kind: "action",
        id: "player:stream-info",
        title: "Stream info",
        keywords: ["codec", "direct", "transcode", "bitrate"],
        leading: { kind: "icon", icon: InfoIcon },
        perform: player.showStreamInfo,
      },
      {
        kind: "action",
        id: "player:fullscreen",
        title: "Full screen",
        leading: { kind: "icon", icon: MaximizeIcon },
        keycaps: playerKeymap.keycaps("player.fullscreen"),
        perform: player.toggleFullscreen,
      },
    ];

    return { groups: [{ id: "playback", label: "Playback", items }] };
  }, [player]);
};
