import type { CommandItem, CommandPage } from "@movies/ui/lib/command-menu";
import { describe, expect, it } from "vitest";

import type { PlayerCommands } from "./contribution";
import { playbackCommands } from "./playback";

const noop = (): void => undefined;

/** A player with two audio tracks and a subtitle track that records what the menu chooses. */
const recordingPlayer = (overrides: Partial<PlayerCommands> = {}) => {
  const chosen: Array<string> = [];

  const player: PlayerCommands = {
    playing: true,
    controlsTimeline: true,
    togglePlay: noop,
    skip: noop,
    toggleFullscreen: noop,
    showStreamInfo: noop,
    subtitles: [
      { id: "off", label: "Off" },
      { id: "s1", label: "English" },
    ],
    subtitleId: "off",
    selectSubtitle: (id) => {
      chosen.push(`subtitles:${id}`);
    },
    audio: [
      { id: "1", label: "English Stereo" },
      { id: "2", label: "French Stereo" },
    ],
    audioId: "1",
    selectAudio: (id) => {
      chosen.push(`audio:${id}`);
    },
    quality: [
      { id: "auto", label: "Auto" },
      { id: "480p", label: "480p" },
    ],
    qualityId: "auto",
    selectQuality: (id) => {
      chosen.push(`quality:${id}`);
    },
    versions: [],
    versionId: "",
    selectVersion: noop,
    nextEpisode: noop,
    startRoom: null,
    room: null,
    ...overrides,
  };

  return { player, chosen };
};

const items = (player: PlayerCommands): ReadonlyArray<CommandItem> =>
  playbackCommands(player).groups.flatMap((group) => group.items);

const submenu = (player: PlayerCommands, id: string): CommandPage => {
  const item = items(player).find((candidate) => candidate.id === id);

  if (item?.kind !== "submenu") throw new Error(`${id} is not a submenu`);

  return item.page;
};

const options = (page: CommandPage): ReadonlyArray<CommandItem> =>
  page.groups.flatMap((group) => group.items);

describe("playbackCommands", () => {
  it("offers nothing without a player", () => {
    expect(playbackCommands(null).groups).toEqual([]);
  });

  it("gives the player one Playback group with transport, tracks, and the frame", () => {
    const { player } = recordingPlayer();
    const { groups } = playbackCommands(player);

    expect(groups.map((group) => group.label)).toEqual(["Playback"]);
    expect(items(player).map((item) => item.title)).toEqual([
      "Pause",
      "Back 10 seconds",
      "Forward 10 seconds",
      "Next episode",
      "Subtitles",
      "Audio",
      "Quality",
      "Stream info",
      "Full screen",
    ]);
  });

  it("lists each track with the current one checked, and chooses through the player", () => {
    const { player, chosen } = recordingPlayer();

    for (const [id, expected] of [
      ["player:audio", ["English Stereo", "French Stereo"]],
      ["player:subtitles", ["Off", "English"]],
      ["player:quality", ["Auto", "480p"]],
    ] as const) {
      const list = options(submenu(player, id));

      expect(list.map((option) => option.title)).toEqual(expected);
      expect(list.map((option) => option.leading?.kind === "check")).toEqual([true, false]);
      expect(list.map((option) => option.checked)).toEqual([true, false]);

      const last = list.at(-1);

      if (last?.kind === "action") void last.perform();
    }

    expect(chosen).toEqual(["audio:2", "subtitles:s1", "quality:480p"]);
  });

  it("leaves guests the tracks but not the timeline", () => {
    const { player } = recordingPlayer({ controlsTimeline: false });

    expect(items(player).map((item) => item.title)).toEqual([
      "Subtitles",
      "Audio",
      "Quality",
      "Stream info",
      "Full screen",
    ]);
  });

  it("drops Stream info where its panel cannot show", () => {
    const { player } = recordingPlayer({ showStreamInfo: null });

    expect(items(player).map((item) => item.title)).not.toContain("Stream info");
  });

  it("drops Audio for a file without audio and adds Version for a title with several files", () => {
    const { player } = recordingPlayer({
      audio: [],
      versions: [
        { id: "a", label: "Remastered" },
        { id: "b", label: "Standard" },
      ],
      versionId: "b",
    });

    const titles = items(player).map((item) => item.title);

    expect(titles).not.toContain("Audio");
    expect(titles).toContain("Version");
    expect(
      options(submenu(player, "player:version")).map((option) => option.leading?.kind),
    ).toEqual([undefined, "check"]);
  });
});
