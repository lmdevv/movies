/**
 * Playback against the real media service, one clip per rung of the ladder as Chromium meets it:
 * an MP4 plays directly, an MPEG-TS file remuxes to HLS, AC-3 audio is converted, and HEVC is
 * transcoded in software. Around them: the keyboard, progress landing in Continue watching, the
 * resume prompt, subtitles and audio switching, a seek outside what a transcode produced, autoplay
 * of the next episode, and a file gone from disk. Runs after the admin suites on the same stack,
 * signed in as their owner; first-frame times per mode go to the test's annotations.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EpisodeId, TitleId } from "@movies/contracts/ids";
import { MEDIA_ROUTES } from "@movies/contracts/media-playback";
import type { PlaybackMode } from "@movies/contracts/models/playback";
import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  adultProfile,
  capture,
  clickScrubber,
  commandMenu,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  expectPositionNear,
  firstFrameMs,
  holdKey,
  leaveDialog,
  leaveWithEscape,
  movieNfo,
  offline,
  revealControls,
  scanLibrary,
  showNfo,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";
import { recordStreams, refuseQualityCaps } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Encoding the clips and bundling the service take a while on a cold machine. */
const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const SRT = `1
00:00:00,500 --> 00:01:00,000
The lighthouse keeper climbs the stairs.

2
00:01:00,500 --> 00:02:00,000
The lamp turns all night.
`;

/** The suite's movies: one per playback path, plus one whose file goes missing. */
const MOVIES = {
  direct: "Lighthouse Keeper",
  remux: "Signal Box",
  audio: "Night Ferry",
  transcode: "Glass Harbor",
  missing: "Lost Reel",
  pictures: "Paper Lantern",
} as const;

/** DVD subtitles (VobSub) the media service tests carry; see their fixtures README. */
const VOBSUB = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "media",
  "src",
  "testing",
  "fixtures",
  "vobsub.mkv",
);

/** The player's tracks button and its popover. */
const TRACKS = "Audio, subtitles, and quality";

const SHOW = "Tide Tables";

const EPISODES = ["Low Water", "Slack Tide", "Spring Tide"] as const;

/** The show's second season, for browsing seasons in the player's episode picker. */
const SEASON_TWO = ["Neap Tide"] as const;

/** How long each episode runs; autoplay offers the next one in its last tenth. */
const EPISODE_SECONDS = 30;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

const titles = new Map<string, TitleId>();

const episodes: Array<EpisodeId> = [];

const seasonTwo: Array<EpisodeId> = [];

/** First-frame times by mode, reported once the suite ends. */
const firstFrames: Array<{ readonly mode: string; readonly ms: number }> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-player-"));

  const films = join(workspace, "Films");
  const shows = join(workspace, "Shows");
  const folder = (name: string): string => join(films, `${name} (2021)`);

  const showFolder = join(shows, `${SHOW} (2020)`, "Season 01");

  await Promise.all([
    // Plays directly; the French track is not the default, so choosing it needs HLS.
    encodeClip(join(folder(MOVIES.direct), `${MOVIES.direct} (2021).mp4`), {
      seconds: 120,
      video: "h264",
      audio: [
        { codec: "aac", language: "eng" },
        { codec: "aac", language: "fra" },
      ],
    }),
    writeText(join(folder(MOVIES.direct), `${MOVIES.direct} (2021).en.srt`), SRT),
    encodeClip(join(folder(MOVIES.remux), `${MOVIES.remux} (2021).ts`), {
      seconds: 120,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(folder(MOVIES.audio), `${MOVIES.audio} (2021).mkv`), {
      seconds: 60,
      video: "h264",
      audio: [{ codec: "ac3", language: "eng" }],
    }),
    encodeClip(join(folder(MOVIES.transcode), `${MOVIES.transcode} (2021).mkv`), {
      seconds: 120,
      video: "hevc",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    // 720p with a DVD subtitle track, which only a transcode can show.
    encodeClip(join(folder(MOVIES.pictures), `${MOVIES.pictures} (2021).mkv`), {
      seconds: 30,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
      subtitles: { file: VOBSUB, language: "eng" },
    }),
    encodeClip(join(folder(MOVIES.missing), `${MOVIES.missing} (2021).mp4`), {
      seconds: 10,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    ...Object.values(MOVIES).map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2021)),
    ),
    writeText(join(shows, `${SHOW} (2020)`, "tvshow.nfo"), showNfo(SHOW, 2020)),
    ...EPISODES.flatMap((name, index) => {
      const stem = join(showFolder, `${SHOW} - S01E0${String(index + 1)}`);

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(1, index + 1, name)),
      ];
    }),
    ...SEASON_TWO.flatMap((name, index) => {
      const stem = join(
        shows,
        `${SHOW} (2020)`,
        "Season 02",
        `${SHOW} - S02E0${String(index + 1)}`,
      );

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(2, index + 1, name)),
      ];
    }),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const filmsId = await scanLibrary(owner.sdk, {
    name: `Playback films ${run}`,
    kind: "movies",
    root: films,
    access: "everyone",
  });

  const showsId = await scanLibrary(owner.sdk, {
    name: `Playback shows ${run}`,
    kind: "shows",
    root: shows,
    access: "everyone",
  });

  const scanned = await Promise.all([filmsId, showsId].map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

  const profile = await adultProfile(owner.sdk);

  const season = await owner.sdk.query("titles.episodes", {
    profileId: profile.id,
    titleId: titleId(SHOW),
    seasonNumber: 1,
  });

  episodes.push(...season.map((episode) => episode.id));

  const second = await owner.sdk.query("titles.episodes", {
    profileId: profile.id,
    titleId: titleId(SHOW),
    seasonNumber: 2,
  });

  seasonTwo.push(...second.map((episode) => episode.id));
  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  await useSession(page, owner);
});

test.afterAll(async () => {
  if (stack === null) return;

  test.info().annotations.push({
    type: "first-frame",
    description: firstFrames.map(({ mode, ms }) => `${mode} ${String(ms)} ms`).join(", "),
  });

  // The numbers the milestone report quotes.
  console.log(`First frame by mode: ${JSON.stringify(firstFrames)}`);
  await context.close();
  await owner.sdk.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

function titleId(name: string): TitleId {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
}

/** Opens the player at the beginning and waits for the first frame of `mode`. */
const playFromStart = async (name: string, mode: PlaybackMode): Promise<void> => {
  const before = streams.length;

  await page.goto(`/watch/${titleId(name)}?start=0`);
  await expectPlayingPast(page, 0.5);
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe(mode);
  firstFrames.push({ mode, ms: await firstFrameMs(page) });
};

/** The subtitle track the player shows, with its cue count, or null when none shows. */
const showingSubtitle = () =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return null;

    const track = Array.from(element.textTracks).find((each) => each.mode === "showing");

    return track === undefined ? null : { label: track.label, cues: track.cues?.length ?? 0 };
  });

const activeRung = (target: Page) =>
  target.getByRole("list", { name: "Playback mode" }).locator('[aria-current="true"]');

test("a direct file plays, answers the keyboard, and lands in Continue watching", async () => {
  await playFromStart(MOVIES.direct, "direct");

  const player = page.getByTestId("player");

  // j and l move ten seconds, the arrows five.
  const at = (await videoState(page)).currentTime;

  await player.press("l");
  await expectPositionNear(page, at + 10, 1.5);
  await player.press("ArrowRight");
  await expectPositionNear(page, at + 15, 1.5);
  await player.press("j");
  await expectPositionNear(page, at + 5, 1.5);
  await player.press("ArrowLeft");
  await expectPositionNear(page, at, 1.5);

  // Presses quicker than a render add up: the second counts from where the first landed.
  // Read in the same task, before playback moves on.
  const quick = await page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    const before = element.currentTime;

    for (const key of ["l", "l"]) window.dispatchEvent(new KeyboardEvent("keydown", { key }));

    return element.currentTime - before;
  });

  expect(quick).toBeCloseTo(20, 1);
  await player.press("j");
  await expectPositionNear(page, at + 10, 1.5);
  await player.press("j");
  await expectPositionNear(page, at, 1.5);

  // k and Space pause and play.
  await player.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await player.press(" ");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  // The volume keys and mute.
  await player.press("ArrowDown");
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.9, 2);
  await player.press("ArrowUp");
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(1, 2);
  await player.press("m");
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await player.press("m");
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);

  // Stream info names the rung; codec details live only there.
  await revealControls(page);
  await capture(page, "07-01-playing");
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Direct");
  await page.getByRole("button", { name: "Close stream info" }).click();

  // Watch to past twenty seconds, then leave: the session ends where it stopped.
  await player.press("l");
  await player.press("l");
  await expectPlayingPast(page, 21);
  await leaveWithEscape(page);
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.direct)}$`, "u"));

  // In the app, as a viewer would: a reload would cut off the report of where playback stopped.
  await page.getByRole("link", { name: "[movies] home" }).click();

  const row = page.getByRole("region", { name: /^Continue watching/u });

  await expect(row).toContainText(MOVIES.direct);
});

test("the resume prompt resumes where the profile stopped, or starts over", async () => {
  await page.goto(`/watch/${titleId(MOVIES.direct)}`);
  await expect(page.getByRole("heading", { name: /^Welcome back, / })).toBeVisible();

  const resume = page.getByRole("button", { name: /^Resume from 0:2\d$/u });

  await expect(resume).toBeVisible();
  await capture(page, "07-04-resume-prompt");
  await resume.click();
  await expectPlayingPast(page, 20);

  await page.reload();
  await page.getByRole("button", { name: "Start from beginning" }).click();
  await expectPlayingPast(page, 0.5);
  expect((await videoState(page)).currentTime).toBeLessThan(10);
});

test("subtitles show from the track popover and toggle with c; another audio track renegotiates", async () => {
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();

  const panel = page.getByRole("dialog", { name: TRACKS });

  await panel.getByRole("radio", { name: "English" }).last().click();
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });
  await capture(page, "07-02b-subtitles");
  await page.keyboard.press("Escape");
  await page.getByTestId("player").press("c");
  await expect.poll(showingSubtitle).toBeNull();
  await page.getByTestId("player").press("c");
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });

  // A track the browser cannot pick from the file needs the media service to remux it.
  const before = streams.length;
  const position = (await videoState(page)).currentTime;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await capture(page, "07-02-audio-and-subtitles");
  await panel.getByRole("radio", { name: "French" }).click();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await expectPlayingPast(page, position);
  await expect(panel.getByRole("radio", { name: "French" })).toBeChecked();

  // Leaving stops the remuxed stream, which replaced the direct one the session started with.
  const streamId = streams.at(-1)?.streamId;

  if (streamId === undefined) throw new Error("The remux has no stream id");

  const stopped = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/playback/stop") && (request.postData() ?? "").includes(streamId),
  );

  await page.keyboard.press("Escape");
  await leaveWithEscape(page);
  await stopped;
});

test("⌘K lists the player's audio, subtitles, and quality, and switches them as the track menu does", async () => {
  await playFromStart(MOVIES.direct, "direct");

  const { menu, playback } = commandMenu(page);
  const onPlayer = new RegExp(`/watch/${titleId(MOVIES.direct)}`, "u");

  await page.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [
      /^Pause/u,
      /^Back 10 seconds/u,
      /^Forward 10 seconds/u,
      /^Subtitles/u,
      /^Audio/u,
      /^Quality/u,
      /^Stream info/u,
      /^Full screen/u,
    ].map((name) => expect(playback.getByRole("option", { name })).toBeVisible()),
  );

  await capture(page, "07-11-command-menu-playback");

  // Audio lists both tracks with the playing one checked; French remuxes, as from the track menu.
  await playback.getByRole("option", { name: /^Audio/u }).click();

  const audio = menu.getByRole("listbox", { name: "Audio" });

  await expect(audio.getByRole("option")).toHaveText([/^English/u, /^French/u]);
  await expect(audio.getByRole("option", { name: /^English/u })).toBeChecked();

  const before = streams.length;

  await audio.getByRole("option", { name: /^French/u }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(
    page.getByRole("dialog", { name: TRACKS }).getByRole("radio", { name: "French" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");

  // Subtitles: Off is checked until the English track is chosen, which then shows.
  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Subtitles/u }).click();

  const subtitles = menu.getByRole("listbox", { name: "Subtitles" });

  await expect(subtitles.getByRole("option")).toHaveText(["Off", "English"]);
  await expect(subtitles.getByRole("option", { name: "Off" })).toBeChecked();
  await subtitles.getByRole("option", { name: "English" }).click();
  await expect.poll(showingSubtitle).toEqual({ label: "English", cues: 2 });

  // Quality shows the current choice. Escape goes back a level, then closes; neither leaves.
  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Quality/u }).click();
  await expect(
    menu.getByRole("listbox", { name: "Quality" }).getByRole("option", { name: "Auto" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(playback).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(onPlayer);

  // Full screen: the menu opens inside the player, and its commands work there.
  await page.getByTestId("player").press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await page.keyboard.press("ControlOrMeta+k");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement?.contains(
            document.querySelector('[data-slot="command-menu"]'),
          ) ?? false,
      ),
    )
    .toBe(true);

  // Full screen ending under the open menu (as the browser's own Escape does) leaves it open, with
  // the keyboard still in its input.
  const search = menu.getByRole("combobox");

  await expect(search).toBeFocused();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(playback).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();

  // Back to full screen: the menu's commands work there.
  await page.getByTestId("player").press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Pause/u }).click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  // Escape leaves full screen and nothing more: the player stays, and nothing asks.
  await page.getByTestId("player").press("Escape");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(onPlayer);

  // Away from the player the menu has no player commands.
  await leaveWithEscape(page);
  await expect(page.getByRole("heading", { name: MOVIES.direct, level: 1 })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
  await expect(playback).toHaveCount(0);
  await expect(menu.getByRole("option", { name: /^Audio/u })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Escape asks before leaving: open layers close first, Stay plays on, Leave goes back", async () => {
  await playFromStart(MOVIES.remux, "remux");

  const player = page.getByTestId("player");
  const leave = leaveDialog(page);
  const stay = leave.getByRole("button", { name: "Stay" });
  const onPlayer = new RegExp(`/watch/${titleId(MOVIES.remux)}`, "u");
  const paused = async () => (await videoState(page)).paused;

  // With nothing open, Escape asks and pauses, with focus on Stay. Escape again plays on.
  await player.press("Escape");
  await expect(leave).toBeVisible();
  await expect(stay).toBeFocused();
  await expect.poll(paused).toBe(true);
  await expect(leave).toHaveCSS("opacity", "1");
  await capture(page, "07-12-leave-playback");
  await page.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  await expect(player).toBeFocused();
  await expect.poll(paused).toBe(false);

  // From a focused control, focus goes back to that control.
  const streamInfo = page.getByRole("button", { name: "Stream info" });

  await revealControls(page);
  await streamInfo.focus();
  await page.keyboard.press("Escape");
  await expect(stay).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(leave).toBeHidden();
  await expect(streamInfo).toBeFocused();

  // Stay and a click outside the dialog play on too.
  await player.press("Escape");
  await stay.click();
  await expect(leave).toBeHidden();
  await expect.poll(paused).toBe(false);
  await player.press("Escape");
  await expect(leave).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(leave).toBeHidden();
  await expect.poll(paused).toBe(false);

  // Paused before asking, Stay keeps it paused.
  await player.press("k");
  await expect.poll(paused).toBe(true);
  await player.press("Escape");
  await stay.click();
  await expect(leave).toBeHidden();
  await page.waitForTimeout(500);
  expect(await paused()).toBe(true);
  await player.press("k");
  await expect.poll(paused).toBe(false);

  // An open layer takes Escape first, even held down.
  const panel = page.getByRole("dialog", { name: TRACKS });

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(panel).toBeVisible();

  await holdKey(page, "Escape", 4);
  await expect(panel).toBeHidden();
  await expect(leave).toBeHidden();

  const { menu } = commandMenu(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(leave).toBeHidden();

  const info = page.getByRole("region", { name: "Stream info" });

  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(info).toBeVisible();
  await player.press("Escape");
  await expect(info).toBeHidden();
  await expect(leave).toBeHidden();
  await expect(page).toHaveURL(onPlayer);
  await expect.poll(paused).toBe(false);

  // Held with nothing open, Escape asks once, and the dialog stays.
  await player.focus();

  await holdKey(page, "Escape", 4);
  await expect(leave).toBeVisible();
  await page.waitForTimeout(500);
  await expect(leave).toBeVisible();

  // From the keyboard: Tab moves from Stay to Leave, Enter leaves, and the stream stops once.
  const stops: Array<string> = [];

  const onRequest = (request: Request) => {
    if (request.url().endsWith(MEDIA_ROUTES.stop)) stops.push(request.url());
  };

  page.on("request", onRequest);
  await page.keyboard.press("Tab");
  await expect(leave.getByRole("button", { name: "Leave", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.remux)}$`, "u"));
  await page.waitForTimeout(1_000);
  page.off("request", onRequest);
  expect(stops).toHaveLength(1);

  // The visible Back button leaves without asking.
  await playFromStart(MOVIES.remux, "remux");
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(MOVIES.remux)}$`, "u"));
  await expect(leave).toHaveCount(0);
});

test("a picture subtitle burns into a transcode and back out; a lower quality transcodes down", async () => {
  await playFromStart(MOVIES.pictures, "remux");

  const panel = page.getByRole("dialog", { name: TRACKS });

  // The panel closes with the controls while a stream plays, so each choice opens it again.
  const openPanel = async () => {
    if (await panel.isVisible()) return;
    await revealControls(page);
    await page.getByRole("button", { name: TRACKS }).click();
  };

  const choose = async (name: string) => {
    await openPanel();
    await panel.getByRole("radio", { name }).last().click();
  };

  await openPanel();
  await capture(page, "07-08-tracks-and-quality");

  let before = streams.length;

  await choose("English");
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("transcode-software");
  expect(streams.at(-1)?.burnedInSubtitle).toMatch(/^e\d+$/u);
  await expectPlayingPast(page, 1);

  // Off returns to the copy, without a burned-in subtitle.
  before = streams.length;
  await choose("Off");
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "remux", burnedInSubtitle: undefined });

  // 480p transcodes the 720p source down, and the browser remembers the choice.
  before = streams.length;
  await choose("480p");
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "transcode-software", height: 480 });
  await expectPlayingPast(page, 1);

  before = streams.length;
  await page.reload();
  await expect.poll(() => streams.slice(before).at(-1)?.height).toBe(480);
  await expectPlayingPast(page, 0.5);
  await openPanel();
  await expect(panel.getByRole("radio", { name: "480p" })).toBeChecked();

  // Auto plays the source again; later tests expect it.
  before = streams.length;
  await choose("Auto");
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
});

test("a quality the media service cannot encode now gives way to the stream that plays", async () => {
  const panel = page.getByRole("dialog", { name: TRACKS });

  const openPanel = async () => {
    if (await panel.isVisible()) return;
    await revealControls(page);
    await page.getByRole("button", { name: TRACKS }).click();
  };

  // Every transcode slot is taken, and the first refusal comes late, after the second choice.
  await refuseQualityCaps(page, 1_000);
  await playFromStart(MOVIES.pictures, "remux");
  await openPanel();
  await panel.getByRole("radio", { name: "720p" }).click();
  await openPanel();
  await panel.getByRole("radio", { name: "480p" }).click();

  // Neither choice can play; the menu returns to the quality of the stream still playing, not to
  // the 720p that never loaded.
  await expect
    .poll(async () => {
      await openPanel();

      return panel.getByRole("radio", { name: "Auto" }).isChecked();
    })
    .toBe(true);
  await expectPlayingPast(page, 1);

  // A remembered 480p the service cannot encode now plays the source instead of stopping.
  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
  await openPanel();
  await panel.getByRole("radio", { name: "480p" }).click();
  await expect.poll(() => streams.at(-1)?.height).toBe(480);
  await refuseQualityCaps(page);

  const before = streams.length;

  await page.reload();
  await expect.poll(() => streams.slice(before).at(-1)?.mode).toBe("remux");
  await expectPlayingPast(page, 0.5);
  await openPanel();
  await expect(panel.getByRole("radio", { name: "Auto" })).toBeChecked();
  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
});

test("an MPEG-TS file remuxes to HLS", async () => {
  await playFromStart(MOVIES.remux, "remux");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Remux");
});

test("AC-3 audio is converted while the video is copied", async () => {
  await playFromStart(MOVIES.audio, "audio-transcode");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Remux");
  await expect(page.getByRole("region", { name: "Stream info" })).toContainText("converted");
});

test("HEVC transcodes in software, and a seek past what is produced moves the stream", async () => {
  await playFromStart(MOVIES.transcode, "transcode-software");
  await revealControls(page);
  await page.getByRole("button", { name: "Stream info" }).click();
  await expect(activeRung(page)).toHaveText("Transcode");
  await capture(page, "07-03-stream-info");
  await page.getByRole("button", { name: "Close stream info" }).click();

  const seek = page.waitForResponse((response) => response.url().endsWith("/api/playback/seek"));

  await clickScrubber(page, 0.8);
  expect((await seek).ok()).toBe(true);
  await expectPlayingPast(page, 90, 45_000);
});

test("the next episode plays itself after the countdown; Watch credits cancels it", async () => {
  const [first, second] = episodes;

  if (first === undefined || second === undefined) throw new Error("The show has no episodes");

  await page.goto(`/watch/${titleId(SHOW)}?episodeId=${first}&start=0`);
  await expectPlayingPast(page, 0.5);

  const player = page.getByTestId("player");

  await player.press("l");
  await player.press("l");
  await player.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Watch credits" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(EPISODES[1])).toBeVisible();
  await capture(page, "07-05-autoplay-next");
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"), { timeout: 20_000 });
  await expectPlayingPast(page, 0.5);

  // On the second episode, Watch credits keeps playing to the end instead.
  await player.press("l");
  await player.press("l");
  await player.press("ArrowRight");

  const credits = page.getByRole("button", { name: "Watch credits" });

  // While "Leave playback?" asks, the ten-second countdown waits instead of moving on behind it.
  await expect(credits).toBeVisible({ timeout: 10_000 });
  await player.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await page.waitForTimeout(11_000);
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeHidden();
  await credits.click();
  await expect(credits).toBeHidden();
  await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(29);
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
});

/** The bottom controls, which fade out while the viewer is idle unless something holds them. */
const controlsShown = (target: Page) =>
  target.locator('[data-slot="player-controls"]').evaluate((element) => {
    const { opacity } = getComputedStyle(element);

    return opacity === "1";
  });

/** Idle for longer than the controls wait before hiding. */
const IDLE_MS = 4_000;

test("hovering the volume button opens a slider that sets the level live and stays in step with mute", async () => {
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);

  const before = streams.length;
  const mute = page.getByRole("button", { name: "Mute", exact: true });
  const unmute = page.getByRole("button", { name: "Unmute", exact: true });
  const slider = page.getByRole("slider", { name: "Volume" });
  const control = page.locator('[data-slot="volume-slider"]');

  await expect(slider).toHaveCount(0);
  await mute.hover();
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", "100%");

  // From the button onto the slider, it stays open, and holds the controls while the pointer rests.
  const box = await control.boundingBox();

  if (box === null) throw new Error("The volume slider is not on screen");

  const at = (fraction: number) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height * (1 - fraction),
  });

  const start = at(1);

  await page.mouse.move(start.x, start.y, { steps: 8 });
  await page.waitForTimeout(IDLE_MS);
  await expect(slider).toBeVisible();
  expect(await controlsShown(page)).toBe(true);
  await capture(page, "07-13-volume-slider");

  // Dragging sets the level as it moves, without pausing or renegotiating the stream.
  await page.mouse.down();
  await page.mouse.move(at(0.6).x, at(0.6).y, { steps: 4 });
  await expect.poll(async () => (await videoState(page)).volume).toBeLessThan(0.75);
  await page.mouse.move(at(0.3).x, at(0.3).y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await videoState(page)).volume).toBeLessThan(0.4);

  const level = (await videoState(page)).volume;

  expect(level).toBeGreaterThan(0.2);
  await expect(slider).toHaveAttribute("aria-valuetext", `${String(Math.round(level * 100))}%`);

  // Mute and the slider agree: muted reads 0, and unmuting returns to the level.
  await mute.click();
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await expect(slider).toHaveAttribute("aria-valuetext", "Muted");
  await unmute.click();
  await expect.poll(async () => (await videoState(page)).muted).toBe(false);
  expect((await videoState(page)).volume).toBeCloseTo(level, 2);

  // Down to nothing mutes; unmuting returns to the level it was dragged from.
  await page.mouse.move(at(0.3).x, at(0.3).y);
  await page.mouse.down();
  await page.mouse.move(at(0).x, box.y + box.height + 8, { steps: 6 });
  await page.mouse.up();
  await expect(unmute).toBeVisible();
  await expect.poll(async () => (await videoState(page)).muted).toBe(true);
  await unmute.click();
  await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(level, 2);
  expect((await videoState(page)).muted).toBe(false);

  // Away from the button and the slider, it closes and stops holding the controls.
  const frame = await page.getByTestId("player").boundingBox();

  if (frame === null) throw new Error("The player is not on screen");

  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 3, { steps: 4 });
  await expect(slider).toHaveCount(0);
  await expect.poll(() => controlsShown(page), { timeout: IDLE_MS + 2_000 }).toBe(false);

  // From the keyboard: tabbing to the button opens it, Tab reaches it, arrows step it.
  await revealControls(page);
  await page.getByRole("button", { name: "Forward 10 seconds" }).focus();
  await page.keyboard.press("Tab");
  await expect(mute).toBeFocused();
  await expect(slider).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(slider).toBeFocused();

  const keyed = Math.round((await videoState(page)).volume * 100);

  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => Math.round((await videoState(page)).volume * 100))
    .toBe(Math.min(100, keyed + 1));
  await expect(slider).toHaveAttribute("aria-valuetext", `${String(Math.min(100, keyed + 1))}%`);
  await page.keyboard.press("PageDown");
  await expect
    .poll(async () => Math.round((await videoState(page)).volume * 100))
    .toBe(Math.min(100, keyed + 1) - 10);

  // The player's other keys still work from the slider: k pauses and plays.
  await page.keyboard.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await page.keyboard.press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  // Escape closes the slider and nothing more; focus returns to the button.
  await page.keyboard.press("Escape");
  await expect(slider).toHaveCount(0);
  await expect(mute).toBeFocused();
  await expect(leaveDialog(page)).toBeHidden();

  expect((await videoState(page)).paused).toBe(false);
  expect(streams.length).toBe(before);
});

test("the episode picker browses seasons and plays earlier and later episodes in the player", async () => {
  const [first, second] = episodes;
  const [later] = seasonTwo;

  if (first === undefined || second === undefined || later === undefined) {
    throw new Error("The show has no episodes");
  }

  await page.goto(`/watch/${titleId(SHOW)}?episodeId=${second}&start=0`);
  await expectPlayingPast(page, 0.5);

  const player = page.getByTestId("player");
  const button = page.getByRole("button", { name: "Episodes", exact: true });
  const picker = page.getByRole("dialog", { name: "Episodes" });
  const current = picker.locator('[aria-current="true"]');

  // Next episode stays beside it.
  await revealControls(page);
  await expect(page.getByRole("button", { name: "Next episode" })).toBeVisible();
  await button.click();
  await expect(picker).toBeVisible();

  // It opens on the season playing, the current episode marked and focused.
  await expect(picker.getByRole("button", { name: "Season 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(picker.locator('[data-slot="episode-row"]')).toHaveText([
    new RegExp(`^1\\s*${EPISODES[0]}`, "u"),
    new RegExp(`^2\\s*${EPISODES[1]}`, "u"),
    new RegExp(`^3\\s*${EPISODES[2]}`, "u"),
  ]);
  await expect(current).toContainText(EPISODES[1]);
  await expect(current).toBeFocused();

  // It holds the controls while open.
  await page.waitForTimeout(IDLE_MS);
  expect(await controlsShown(page)).toBe(true);
  await capture(page, "07-14-episode-picker");

  // Arrows move between episodes without seeking or changing the volume.
  const volume = (await videoState(page)).volume;

  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("button", { name: new RegExp(EPISODES[2], "u") })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(picker.getByRole("button", { name: new RegExp(EPISODES[0], "u") })).toBeFocused();
  expect((await videoState(page)).volume).toBe(volume);

  // Escape closes the picker and nothing more: playback goes on, nothing asks.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  expect((await videoState(page)).paused).toBe(false);

  // A later season's episode plays from the picker.
  await revealControls(page);
  await button.click();
  await picker.getByRole("button", { name: "Season 2", exact: true }).click();
  await expect(picker.locator('[data-slot="episode-row"]')).toHaveText([
    new RegExp(`^1\\s*${SEASON_TWO[0]}`, "u"),
  ]);
  await capture(page, "07-15-episode-picker-season");
  await picker.getByRole("button", { name: new RegExp(SEASON_TWO[0], "u") }).click();
  await expect(page).toHaveURL(new RegExp(`episodeId=${later}`, "u"));
  await expectPlayingPast(page, 0.5);

  // It opens on that season now; an earlier episode plays from Season 1, in full screen too.
  await player.press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
    .toBe("player");
  await revealControls(page);
  await button.click();
  await expect(current).toContainText(SEASON_TWO[0]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement?.contains(
            document.querySelector('[data-slot="episode-list"]'),
          ) ?? false,
      ),
    )
    .toBe(true);

  // Escape closes the picker first; full screen stays until the next press.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await revealControls(page);
  await button.click();
  await picker.getByRole("button", { name: "Season 1", exact: true }).click();
  await picker.getByRole("button", { name: new RegExp(EPISODES[0], "u") }).click();
  await expect(page).toHaveURL(new RegExp(`episodeId=${first}`, "u"));
  await expectPlayingPast(page, 0.5);
  await page.evaluate(() => document.exitFullscreen().catch(() => undefined));

  // A movie has no picker.
  await playFromStart(MOVIES.direct, "direct");
  await revealControls(page);
  await expect(page.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await expect(button).toHaveCount(0);
});

test("touch: a tap opens the volume slider before muting, and the picker plays an episode", async ({
  browser,
}) => {
  if (stack === null) return;

  const [first, second] = episodes;

  if (first === undefined || second === undefined) throw new Error("The show has no episodes");

  // A tablet keeps the desktop controls, with touch.
  const tablet = await browser.newContext({ ...devices["Galaxy Tab S9 landscape"] });
  const touch = await tablet.newPage();

  await useSession(touch, owner);
  await touch.goto(`/watch/${titleId(SHOW)}?episodeId=${first}&start=0`);
  await expectPlayingPast(touch, 0.5);
  await revealControls(touch);

  const slider = touch.getByRole("slider", { name: "Volume" });

  await touch.getByRole("button", { name: "Mute", exact: true }).tap();
  await expect(slider).toBeVisible();
  expect((await videoState(touch)).muted).toBe(false);
  await touch.getByRole("button", { name: "Mute", exact: true }).tap();
  await expect.poll(async () => (await videoState(touch)).muted).toBe(true);
  await touch.getByRole("button", { name: "Unmute", exact: true }).tap();
  await expect.poll(async () => (await videoState(touch)).muted).toBe(false);

  // Left alone, the slider a tap opened closes, and lets the controls hide again.
  await expect(slider).toHaveCount(0, { timeout: 6_000 });

  await touch.getByRole("button", { name: "Episodes", exact: true }).tap();
  await expect(slider).toHaveCount(0);

  const picker = touch.getByRole("dialog", { name: "Episodes" });

  await picker.getByRole("button", { name: new RegExp(EPISODES[1], "u") }).tap();
  await expect(touch).toHaveURL(new RegExp(`episodeId=${second}`, "u"));
  await expectPlayingPast(touch, 0.5);
  await tablet.close();

  // A phone has an Episodes pill under the scrubber.
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const handset = await phone.newPage();

  await useSession(handset, owner);
  await handset.goto(`/watch/${titleId(SHOW)}?episodeId=${second}&start=0`);
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();
  await handset.getByRole("button", { name: "Episodes", exact: true }).tap();

  const phonePicker = handset.getByRole("dialog", { name: "Episodes" });

  await expect(phonePicker.locator('[aria-current="true"]')).toContainText(EPISODES[1]);
  await expect(phonePicker).toHaveCSS("opacity", "1");

  // On a screen this short it stays above the pill, within the screen, and its list scrolls.
  const pill = await handset.getByRole("button", { name: "Episodes", exact: true }).boundingBox();
  const panel = await phonePicker.boundingBox();

  if (pill === null || panel === null) throw new Error("The picker is not on screen");
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(pill.y);
  await capture(handset, "07-16-ios-episode-picker");
  await phonePicker.getByRole("button", { name: new RegExp(EPISODES[0], "u") }).tap();
  await expect(handset).toHaveURL(new RegExp(`episodeId=${first}`, "u"));
  await phone.close();
});

test("a file gone from disk says so instead of playing", async () => {
  await rm(join(workspace, "Films", `${MOVIES.missing} (2021)`, `${MOVIES.missing} (2021).mp4`));
  await page.goto(`/watch/${titleId(MOVIES.missing)}?start=0`);
  await expect(page.getByRole("heading", { name: "We can't find this file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show missing files" })).toBeVisible();
  await capture(page, "07-09-file-missing");
});

test("a phone plays in its own layout, with brightness and volume sliders", async ({ browser }) => {
  if (stack === null) return;

  // Paper's iOS player: an iPhone held sideways, 390 points tall.
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const handset = await phone.newPage();

  await useSession(handset, owner);
  await handset.goto(`/watch/${titleId(MOVIES.direct)}?start=0`);
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();
  await expect(handset.getByRole("slider", { name: "Brightness" })).toBeVisible();
  await expect(handset.getByRole("slider", { name: "Volume" })).toBeVisible();
  await expect(handset.getByRole("button", { name: "Close player" })).toBeVisible();
  await capture(handset, "07-10-ios-player");

  // Close is already deliberate, so it leaves without asking.
  await handset.getByRole("button", { name: "Close player" }).tap();
  await expect(handset).toHaveURL(new RegExp(`/title/${titleId(MOVIES.direct)}$`, "u"));
  await expect(leaveDialog(handset)).toHaveCount(0);
  await phone.close();
});
