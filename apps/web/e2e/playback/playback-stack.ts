/**
 * What the playback suites share: clips encoded for each rung of the playback ladder as Chromium
 * meets it, libraries created and scanned through the SDK the way the admin screens do, and probes
 * that read the player's `<video>` element. Nothing is committed; the suites generate their clips
 * into a temporary folder.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LibraryId, TitleId } from "@movies/contracts/ids";
import type { LibraryAccess, LibraryKind } from "@movies/contracts/models/catalog";
import type { MoviesSdk } from "@movies/sdk/promise";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { StackEnv } from "../stack/stack-env";

const run = promisify(execFile);

const ffmpegPath = process.env["FFMPEG_PATH"] ?? "ffmpeg";

/** An audio track of a clip: its codec and ISO 639-2 language. */
interface ClipAudio {
  readonly codec: "aac" | "ac3";
  readonly language: string;
}

/** How to encode one clip. The container follows the output's extension. */
export interface ClipSpec {
  readonly seconds: number;
  /** H.264 plays in every browser; Chromium has no HEVC decoder, so HEVC is transcoded. */
  readonly video: "h264" | "hevc";
  readonly audio: ReadonlyArray<ClipAudio>;
}

const VIDEO_ARGS: Readonly<Record<ClipSpec["video"], ReadonlyArray<string>>> = {
  h264: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"],
  hevc: [
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-x265-params",
    "log-level=error",
  ],
};

/**
 * Encodes a 640×360, 24 fps test pattern with a keyframe every two seconds (as players seek to
 * keyframes) and one tone per audio track, so each track is audibly its own.
 */
export const encodeClip = async (output: string, spec: ClipSpec): Promise<void> => {
  const duration = String(spec.seconds);

  const audioInputs = spec.audio.flatMap((_, index) => [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${String(330 + index * 110)}:sample_rate=48000:duration=${duration}`,
  ]);

  const audioArgs = spec.audio.flatMap((track, index) => [
    "-map",
    `${String(index + 1)}:a`,
    `-c:a:${String(index)}`,
    track.codec,
    `-ac:a:${String(index)}`,
    "2",
    `-metadata:s:a:${String(index)}`,
    `language=${track.language}`,
  ]);

  await mkdir(dirname(output), { recursive: true });
  await run(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=640x360:rate=24:duration=${duration}`,
    ...audioInputs,
    "-map",
    "0:v",
    ...VIDEO_ARGS[spec.video],
    "-g",
    "48",
    ...audioArgs,
    ...(output.endsWith(".mp4") ? ["-movflags", "+faststart"] : []),
    output,
  ]);
};

/** An NFO that names a movie, so scans match it without a metadata provider. */
export const movieNfo = (name: string, year: number): string => `<?xml version="1.0"?>
<movie>
  <title>${name}</title>
  <year>${String(year)}</year>
</movie>
`;

/** An NFO that names a show. */
export const showNfo = (name: string, year: number): string => `<?xml version="1.0"?>
<tvshow>
  <title>${name}</title>
  <year>${String(year)}</year>
</tvshow>
`;

/** An NFO that names an episode. */
export const episodeNfo = (season: number, episode: number, title: string): string =>
  `<?xml version="1.0"?>
<episodedetails>
  <title>${title}</title>
  <season>${String(season)}</season>
  <episode>${String(episode)}</episode>
</episodedetails>
`;

/** Makes a temporary folder for a suite's clips. */
export const makeWorkspace = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** Removes a suite's folder, or a file in it. */
export const removePath = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Writes `text` to `path`, creating its folder. */
export const writeText = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/**
 * The stack's media service without a metadata provider, so scans name titles from their NFO
 * files and never reach the network.
 */
export const offline = (stack: StackEnv): StackEnv => ({
  ...stack,
  mediaEnv: Object.fromEntries(
    Object.entries(stack.mediaEnv).filter(([name]) => name !== "TMDB_API_KEY"),
  ),
});

/** How long a scan of the suite's clips may take. */
const SCAN_TIMEOUT_MS = 60_000;

/** Creates a library over `root` and waits until its first scan succeeded. */
export const scanLibrary = async (
  sdk: MoviesSdk,
  library: {
    readonly name: string;
    readonly kind: LibraryKind;
    readonly root: string;
    readonly access: LibraryAccess;
  },
): Promise<LibraryId> => {
  const created = await sdk.mutate("libraries.create", {
    name: library.name,
    kind: library.kind,
    roots: [library.root],
    access: library.access,
  });

  await expect
    .poll(async () => (await sdk.query("jobs.get", { jobId: created.jobId })).status, {
      timeout: SCAN_TIMEOUT_MS,
    })
    .toBe("succeeded");

  return created.libraryId;
};

/** The first profile of the signed-in account that needs no PIN and is not a kids profile. */
export const adultProfile = async (sdk: MoviesSdk) => {
  const profiles = await sdk.query("profiles.list", {});
  const profile = profiles.find((each) => !each.locked && !each.kids) ?? profiles[0];

  if (profile === undefined) throw new Error("The account has no profile");

  return profile;
};

/** The ids of a library's titles by name. */
export const titlesByName = async (
  sdk: MoviesSdk,
  libraryId: LibraryId,
): Promise<ReadonlyMap<string, TitleId>> => {
  const profile = await adultProfile(sdk);

  const page = await sdk.query("titles.list", {
    profileId: profile.id,
    libraryId,
    limit: 100,
  });

  return new Map(page.items.map((title) => [title.name, title.id]));
};

/** What the player's `<video>` element reports at one instant. */
export interface VideoState {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly muted: boolean;
  readonly volume: number;
  /** `Date.now()` in the page when it was read. */
  readonly at: number;
}

/** Reads the player's `<video>` element. */
export const videoState = (page: Page): Promise<VideoState> =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    return {
      currentTime: element.currentTime,
      paused: element.paused,
      readyState: element.readyState,
      muted: element.muted,
      volume: element.volume,
      at: Date.now(),
    };
  });

/** Waits until the player plays past `seconds`. */
export const expectPlayingPast = async (
  page: Page,
  seconds: number,
  timeout = 30_000,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const state = await videoState(page);

        return !state.paused && state.currentTime > seconds;
      },
      { timeout },
    )
    .toBe(true);
};

/** Waits until the player's position is within `tolerance` seconds of `seconds`. */
export const expectPositionNear = async (
  page: Page,
  seconds: number,
  tolerance: number,
  timeout = 15_000,
): Promise<void> => {
  await expect
    .poll(async () => Math.abs((await videoState(page)).currentTime - seconds) <= tolerance, {
      timeout,
    })
    .toBe(true);
};

/** User Timing marks the player sets, as `playback-controller.ts` names them. */
const MARKS = { start: "movies:playback-start", firstFrame: "movies:first-frame" } as const;

/**
 * Milliseconds from the last playback start to its first frame: starting the session,
 * negotiating, loading, and decoding.
 */
export const firstFrameMs = (page: Page): Promise<number> =>
  page.evaluate((marks) => {
    const start = performance.getEntriesByName(marks.start).at(-1);
    const frame = performance.getEntriesByName(marks.firstFrame).at(-1);

    if (start === undefined || frame === undefined) throw new Error("No first frame was marked");

    return Math.round(frame.startTime - start.startTime);
  }, MARKS);

/**
 * How far `guest` is from `host` in milliseconds (positive when ahead), from simultaneous reads of
 * both elements while both play. Both pages run in one browser, so their `Date.now()` agree, and
 * the host's position is carried forward to the instant the guest's was read.
 */
export const driftMs = async (host: Page, guest: Page): Promise<number> => {
  const [hostState, guestState] = await Promise.all([videoState(host), videoState(guest)]);
  const hostAtGuest = hostState.currentTime + (guestState.at - hostState.at) / 1000;

  return Math.round((guestState.currentTime - hostAtGuest) * 1000);
};

/** Shows the auto-hiding controls by moving the pointer over the player. */
export const revealControls = async (page: Page): Promise<void> => {
  const player = page.getByTestId("player");
  const box = await player.boundingBox();

  if (box === null) throw new Error("The player is not on screen");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10);
};

/** Clicks the scrubber at `fraction` of its width, as a viewer seeks with the mouse. */
export const clickScrubber = async (page: Page, fraction: number): Promise<void> => {
  await revealControls(page);

  const box = await page.locator('[data-slot="scrubber"]').boundingBox();

  if (box === null) throw new Error("The scrubber is not on screen");

  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
};
