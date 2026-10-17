/**
 * The subtitle delay against the real media service, with subtitle files whose cues sit at known
 * times: Earlier, Later, a typed entry, and Reset move the cues both ways, also while paused; the
 * delay holds through seeks, playing, and a quality change to a transcode that plays through
 * hls.js; another track starts at zero, Off keeps it, and picture subtitles burned into the video
 * cannot be delayed. In a watch room each viewer's delay moves only their own subtitles and never
 * the room's clock.
 */
import { join } from "node:path";

import type { RoomId, TitleId } from "@movies/contracts/ids";
import { RoomId as RoomIdSchema } from "@movies/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { OWNER, createInvite } from "../stack/owner";
import {
  capture,
  encodeClip,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  revealControls,
  scanLibrary,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";
import { recordStreams } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Encoding the clips and bundling the service take a while on a cold machine. */
const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

/** Plays directly; 720p, so 480p transcodes it. English and French subtitle files beside it. */
const FILM = "Tide Clock";

/** A DVD subtitle track (VobSub), which only shows burned into a transcode. */
const PICTURES = "Paper Kite";

/** English cues, in seconds: what each says and where its file puts it. */
const ENGLISH = [
  { text: "Ten seconds.", start: 10, end: 12 },
  { text: "Thirty seconds.", start: 30, end: 32 },
] as const;

const srt = (
  cues: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }>,
) =>
  cues
    .map(
      (cue, index) =>
        `${String(index + 1)}\n00:00:${String(cue.start).padStart(2, "0")},000 --> 00:00:${String(cue.end).padStart(2, "0")},000\n${cue.text}\n`,
    )
    .join("\n");

const FRENCH = [{ text: "Dix secondes.", start: 10, end: 12 }] as const;

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

const GUEST = {
  name: "Robin",
  email: `robin-delay-${run}@movies.test`,
  password: "robin-password-1",
};

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let member: Client;

let hostContext: BrowserContext;

let guestContext: BrowserContext;

let page: Page;

let guest: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

const titles = new Map<string, TitleId>();

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-subtitle-delay-");

  const films = join(workspace, "Films");
  const folder = (name: string): string => join(films, `${name} (2022)`);

  await Promise.all([
    encodeClip(join(folder(FILM), `${FILM} (2022).mp4`), {
      seconds: 60,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(folder(FILM), `${FILM} (2022).en.srt`), srt(ENGLISH)),
    writeText(join(folder(FILM), `${FILM} (2022).fr.srt`), srt(FRENCH)),
    encodeClip(join(folder(PICTURES), `${PICTURES} (2022).mkv`), {
      seconds: 20,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
      subtitles: { file: VOBSUB, language: "eng" },
    }),
    ...[FILM, PICTURES].map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2022)),
    ),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const library = await scanLibrary(owner.sdk, {
    name: `Subtitle delay films ${run}`,
    kind: "movies",
    root: films,
    access: "everyone",
  });

  for (const [name, id] of await titlesByName(owner.sdk, library)) titles.set(name, id);

  const { invite } = await createInvite(stack, OWNER);

  member = openClient(stack);
  await member.sdk.auth.signInWithPassword({
    flow: "signUp",
    email: GUEST.email,
    password: GUEST.password,
    name: GUEST.name,
    inviteCode: invite.code,
  });

  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  page = await hostContext.newPage();
  guest = await guestContext.newPage();
  streams = recordStreams(page);
  await useSession(page, owner);
  await useSession(guest, member);
});

test.afterAll(async () => {
  if (stack === null) return;

  await hostContext.close();
  await guestContext.close();
  await owner.sdk.dispose();
  await member.sdk.dispose();
  await media?.stop();
  await removePath(workspace);
});

function titleId(name: string): TitleId {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
}

/** The subtitle track showing: its label, where its cues start (ms), and what shows now. */
const showing = (target: Page) =>
  target.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return null;

    const track = Array.from(element.textTracks).find((each) => each.mode === "showing");

    if (track === undefined) return null;

    return {
      label: track.label,
      starts: Array.from(track.cues ?? [], (cue) => Math.round(cue.startTime * 1000)),
      active: Array.from(track.activeCues ?? [], (cue) => (cue instanceof VTTCue ? cue.text : "")),
    };
  });

/** Where the file's English cues start, `delayMs` later. */
const englishStarts = (delayMs: number) => ENGLISH.map((cue) => cue.start * 1000 + delayMs);

/** Moves the paused element to `seconds`, a position a direct file always reaches. */
const seekElement = async (target: Page, seconds: number): Promise<void> => {
  await target.getByTestId("player-video").evaluate(async (element, to) => {
    if (!(element instanceof HTMLVideoElement)) return;

    const seeked = new Promise((resolve) => {
      element.addEventListener("seeked", resolve, { once: true });
    });

    element.currentTime = to;
    await seeked;
  }, seconds);
};

/** The track popover, opened from the controls when it is not open yet. */
const tracksPanel = async (target: Page): Promise<Locator> => {
  const panel = target.getByRole("dialog", { name: TRACKS });

  if (!(await panel.isVisible())) {
    await revealControls(target);
    await target.getByRole("button", { name: TRACKS }).click();
  }

  return panel;
};

/** Closes the track popover with Escape and waits until it has gone. */
const closeTracks = async (target: Page): Promise<void> => {
  await target.keyboard.press("Escape");
  await expect(target.getByRole("dialog", { name: TRACKS })).toBeHidden();
};

/** The subtitle delay control in the open track popover. */
const delayControl = (panel: Locator): Locator =>
  panel.getByRole("group", { name: "Subtitle delay" });

const chooseSubtitle = async (target: Page, name: string): Promise<void> => {
  const panel = await tracksPanel(target);

  await panel.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio", { name }).click();
};

/** Types `seconds` into the delay field and presses Enter. */
const enterDelay = async (target: Page, seconds: string): Promise<void> => {
  const field = delayControl(await tracksPanel(target)).getByRole("textbox", {
    name: "Subtitle delay in seconds",
  });

  await field.fill(seconds);
  await field.press("Enter");
};

/** Does `act` `times` times, each after the one before has finished. */
const repeat = async (times: number, act: () => Promise<void>): Promise<void> => {
  if (times === 0) return;
  await act();
  await repeat(times - 1, act);
};

/** Opens `name` from the beginning, plays it past half a second, and pauses it. */
const openPaused = async (target: Page, name: string): Promise<void> => {
  await target.goto(`/watch/${titleId(name)}?start=0`);
  await expectPlayingPast(target, 0.5);
  await target.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(target)).paused).toBe(true);
};

test("Earlier, Later, a typed delay, and Reset move the cues both ways while paused", async () => {
  await openPaused(page, FILM);
  await chooseSubtitle(page, "English");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0) });

  const panel = await tracksPanel(page);
  const control = delayControl(panel);
  const field = control.getByRole("textbox", { name: "Subtitle delay in seconds" });

  await expect(field).toHaveValue("0.0");
  await expect(control.getByRole("button", { name: "Reset" })).toBeDisabled();
  await expect(control.getByRole("button", { name: "Earlier" })).toHaveText("G");
  await expect(control.getByRole("button", { name: "Later" })).toHaveText("H");

  // At 9 s nothing shows yet: the first cue starts at 10 s.
  await seekElement(page, 9);
  await expect.poll(() => showing(page)).toMatchObject({ active: [] });

  // Later by a second: the cue now starts at 11 s.
  await repeat(10, () => control.getByRole("button", { name: "Later" }).click());

  await expect(field).toHaveValue("+1.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(1000), active: [] });

  // 1.5 s earlier than the file: the first cue runs 8.5 to 10.5 s and shows at 9 s, paused.
  await enterDelay(page, "-1.5");
  await expect(field).toHaveValue("−1.5");
  await expect
    .poll(() => showing(page))
    .toMatchObject({ starts: englishStarts(-1500), active: ["Ten seconds."] });
  await capture(page, "subtitle-delay-earlier");

  // An entry that is no number leaves the delay as it was; one past the range stops at its end.
  await enterDelay(page, "soon");
  await expect(field).toHaveValue("−1.5");
  await enterDelay(page, "45");
  await expect(field).toHaveValue("+30.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(30_000) });

  await control.getByRole("button", { name: "Reset" }).click();
  await expect(field).toHaveValue("0.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0), active: [] });

  // G and H step from the keyboard with the popover closed, and say where the delay is.
  await closeTracks(page);

  const player = page.getByTestId("player");

  await repeat(3, () => player.press("h"));
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "+0.3 s",
  );
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(300) });
  await capture(page, "subtitle-delay-notice");

  await repeat(5, () => player.press("g"));
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "−0.2 s",
  );
});

test("the delay holds through seeks, playing, and a quality change to an hls.js transcode", async () => {
  // A seek through the player and back.
  const player = page.getByTestId("player");

  await player.press("ArrowRight");
  await player.press("ArrowLeft");
  await seekElement(page, 9.9);
  await expect
    .poll(() => showing(page))
    .toMatchObject({ starts: englishStarts(-200), active: ["Ten seconds."] });

  // Playing on; the quality change below happens while it plays.
  await player.press("k");
  await expectPlayingPast(page, 10.5);
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });

  // 480p transcodes the 720p file to HLS, which this browser plays through hls.js.
  const before = streams.length;
  const panel = await tracksPanel(page);

  await panel
    .getByRole("radiogroup", { name: "Quality" })
    .getByRole("radio", { name: "480p" })
    .click();
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "transcode-software", height: 480 });
  await expectPlayingPast(page, 11);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const field = delayControl(await tracksPanel(page)).getByRole("textbox", {
    name: "Subtitle delay in seconds",
  });

  await expect(field).toHaveValue("−0.2");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });

  // Where the transcode paused, a delay that puts the first cue around it shows the cue there,
  // and one that moves it past shows nothing: the cues move on the hls.js stream too.
  const at = (await videoState(page)).currentTime;
  const around = Math.round((at - 11) * 100) / 100;

  await enterDelay(page, String(around));
  await expect.poll(() => showing(page)).toMatchObject({ active: ["Ten seconds."] });
  await enterDelay(page, String(around + 3));
  await expect.poll(() => showing(page)).toMatchObject({ active: [] });

  // Auto again, which later tests and visits expect.
  const back = streams.length;

  await (
    await tracksPanel(page)
  )
    .getByRole("radiogroup", { name: "Quality" })
    .getByRole("radio", { name: "Auto" })
    .click();
  await expect.poll(() => streams.slice(back).at(-1)?.mode).toBe("direct");
});

test("another track starts at zero, Off keeps the delay, and the control says why it is off", async () => {
  await openPaused(page, FILM);
  await chooseSubtitle(page, "English");
  await enterDelay(page, "0.5");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(500) });

  const control = delayControl(await tracksPanel(page));
  const field = control.getByRole("textbox", { name: "Subtitle delay in seconds" });

  // French starts from its file's timing.
  await chooseSubtitle(page, "French");
  await expect(field).toHaveValue("0.0");
  await expect
    .poll(() => showing(page))
    .toMatchObject({ label: "French", starts: [FRENCH[0].start * 1000] });

  // Back to English, which is another track again: zero as well.
  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("0.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0) });

  // Off disables the control and says why; the same track again has its delay back.
  await enterDelay(page, "-0.7");
  await chooseSubtitle(page, "Off");
  await expect(control).toContainText("Subtitles are off");
  await expect(field).toBeDisabled();
  await expect(control.getByRole("button", { name: "Later" })).toBeDisabled();
  await capture(page, "subtitle-delay-off");
  await closeTracks(page);
  await page.getByTestId("player").press("h");
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "Subtitles are off",
  );

  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("−0.7");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-700) });

  // A reload is a new playback: no delay.
  await page.reload();
  await expectPlayingPast(page, 0.5);
  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("0.0");
});

test("a picture subtitle is drawn into the video, so its delay is off with the reason", async () => {
  await openPaused(page, PICTURES);
  await chooseSubtitle(page, "English (VobSub)");

  const control = delayControl(await tracksPanel(page));

  await expect(control).toContainText("Burned into the video");
  await expect(control.getByRole("button", { name: "Earlier" })).toBeDisabled();
  await expect(control.getByRole("textbox")).toBeDisabled();
  await capture(page, "subtitle-delay-burned-in");
});

test("in a room each viewer's delay moves only their own subtitles, never the room's clock", async () => {
  await page.goto(`/watch/${titleId(FILM)}?start=0`);
  await expectPlayingPast(page, 1);

  // Start a room from the controls.
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();

  const dialog = page.getByRole("dialog", { name: "Watch together" });

  await expect(dialog.getByLabel("Room link")).toContainText("/r/");
  await dialog.getByRole("button", { name: "Start room" }).click();
  await expect(page).toHaveURL(/[?&]room=/u);

  const roomId: RoomId = Schema.decodeSync(RoomIdSchema)(
    new URL(page.url()).searchParams.get("room") ?? "",
  );

  await guest.goto(`/r/${roomId}`);
  await expectPlayingPast(guest, 2);

  await chooseSubtitle(page, "English");
  await chooseSubtitle(guest, "English");

  const clockBefore = (await owner.sdk.query("rooms.get", { roomId })).clock.revision;

  await enterDelay(page, "2");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(2000) });
  await expect.poll(() => showing(guest)).toMatchObject({ starts: englishStarts(0) });

  await enterDelay(guest, "-1");
  await expect.poll(() => showing(guest)).toMatchObject({ starts: englishStarts(-1000) });
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(2000) });

  // The guest, who cannot move the room's timeline, has the control as anyone does.
  await capture(guest, "subtitle-delay-guest");

  const states = await Promise.all([page, guest].map((target) => videoState(target)));

  expect(states.map((state) => state.paused)).toEqual([false, false]);

  expect((await owner.sdk.query("rooms.get", { roomId })).clock.revision).toBe(clockBefore);
});
