/**
 * Versions against the real media service: a film with two editions, one an MP4 Chromium plays
 * directly and one a taller MKV it needs remuxed, and an episode with two files. The title page
 * offers a Version select whose choice Play plays; the player switches files in place, keeping the
 * position; and the profile's last choice comes back on the title page and in a plain play. Runs
 * after the casting suite on the same stack, signed in as its owner.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MediaFileId, TitleId } from "@movies/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { recordStreams, refuseNextNegotiation } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";
import {
  adultProfile,
  capture,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  expectPositionNear,
  movieNfo,
  offline,
  revealControls,
  scanLibrary,
  showNfo,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const MOVIE = "Tidewater";

const SHOW = "Ebb Tide";

/** The player's tracks button and its popover. */
const TRACKS = "Audio, subtitles, and quality";

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

let movieId: TitleId;

let showId: TitleId;

/** The film's files by edition. */
const files = new Map<string, MediaFileId>();

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-versions-"));

  const films = join(workspace, "Films");
  const film = join(films, `${MOVIE} (2021)`);
  const shows = join(workspace, "Shows");
  const season = join(shows, `${SHOW} (2020)`, "Season 01");

  await Promise.all([
    // Chromium plays the MP4 directly; the taller MKV needs a remux.
    encodeClip(join(film, `${MOVIE} (2021) {edition-Standard}.mp4`), {
      seconds: 60,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(film, `${MOVIE} (2021) {edition-Remastered}.mkv`), {
      seconds: 60,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(film, "movie.nfo"), movieNfo(MOVIE, 2021)),
    writeText(join(shows, `${SHOW} (2020)`, "tvshow.nfo"), showNfo(SHOW, 2020)),
    encodeClip(join(season, `${SHOW} - S01E01.mp4`), {
      seconds: 20,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(season, `${SHOW} - S01E01 - 720p.mkv`), {
      seconds: 20,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(season, `${SHOW} - S01E01.nfo`), episodeNfo(1, 1, "Neap")),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const [filmsId, showsId] = await Promise.all([
    scanLibrary(owner.sdk, {
      name: `Versions films ${run}`,
      kind: "movies",
      root: films,
      access: "everyone",
    }),
    scanLibrary(owner.sdk, {
      name: `Versions shows ${run}`,
      kind: "shows",
      root: shows,
      access: "everyone",
    }),
  ]);

  const movie = (await titlesByName(owner.sdk, filmsId)).get(MOVIE);
  const show = (await titlesByName(owner.sdk, showsId)).get(SHOW);

  if (movie === undefined || show === undefined) throw new Error("The clips were not scanned");
  movieId = movie;
  showId = show;

  const profile = await adultProfile(owner.sdk);

  const versions = await owner.sdk.query("titles.versions", {
    profileId: profile.id,
    titleId: movieId,
  });

  for (const version of versions) files.set(version.versionName ?? "", version.id);

  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  await useSession(page, owner);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await owner.sdk.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

/** The file this device's playback session of the film plays, as the server recorded it. */
const sessionFile = async (): Promise<MediaFileId | undefined> => {
  const sessions = await owner.sdk.query("playback.active", {});

  return sessions
    .filter((session) => session.titleId === movieId)
    .toSorted((left, right) => right.startedAt - left.startedAt)[0]?.fileId;
};

/** The film's file of `edition`. */
const fileOf = (edition: string): MediaFileId => {
  const id = files.get(edition);

  if (id === undefined) throw new Error(`The film has no ${edition} edition`);

  return id;
};

/** The show's only episode. */
const firstEpisode = async (): Promise<string> => {
  const profile = await adultProfile(owner.sdk);

  const [episode] = await owner.sdk.query("titles.episodes", {
    profileId: profile.id,
    titleId: showId,
    seasonNumber: 1,
  });

  if (episode === undefined) throw new Error("The show has no episodes");

  return episode.id;
};

/** The Version column of the player's tracks popover. */
const versionGroup = (target: Page) =>
  target.getByRole("dialog", { name: TRACKS }).getByRole("radiogroup", { name: "Version" });

test("a title with two versions offers them beside Play, which plays the chosen one", async () => {
  await page.goto(`/title/${movieId}`);

  const select = page.getByRole("button", { name: "Version" });

  // Nothing played yet: the edition this browser plays directly comes first.
  await expect(select).toContainText("Standard");
  await select.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await capture(page, "05-04-version-select");
  await page.getByRole("menuitemradio", { name: /^Remastered/u }).click();
  await expect(select).toContainText("Remastered");

  const before = streams.length;

  await page.getByRole("link", { name: "Play", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`version=${fileOf("Remastered")}`, "u"));
  await expectPlayingPast(page, 0.5);
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "remux", height: 720 });
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
});

test("the player switches versions in place, keeping the position and the pause", async () => {
  await expectPlayingPast(page, 3);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const position = (await videoState(page)).currentTime;
  const before = streams.length;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await capture(page, "07-02c-versions");
  await versionGroup(page)
    .getByRole("radio", { name: /^Standard/u })
    .click();

  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "direct", height: 360 });
  await expect.poll(sessionFile).toBe(fileOf("Standard"));
  await expectPositionNear(page, position, 0.5);
  expect((await videoState(page)).paused).toBe(true);

  // The panel closed while the new file loaded; it names the new version once opened again.
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(versionGroup(page).getByRole("radio", { name: /^Standard/u })).toBeChecked();
  await page.keyboard.press("Escape");

  // Back to the remaster while playing: it plays on from about where it was.
  await page.getByTestId("player").press("k");
  await expectPlayingPast(page, position + 0.5);

  const playingAt = (await videoState(page)).currentTime;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await versionGroup(page)
    .getByRole("radio", { name: /^Remastered/u })
    .click();
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
  await expectPlayingPast(page, playingAt);
});

test("a version the service cannot stream gives way to the one that played", async () => {
  await expectPlayingPast(page, 1);

  const position = (await videoState(page)).currentTime;
  const url = page.url();

  await refuseNextNegotiation(page);
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await versionGroup(page)
    .getByRole("radio", { name: /^Standard/u })
    .click();

  await expect(page.getByText("This version couldn't play")).toBeVisible();
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
  await expectPlayingPast(page, position);
  expect(page.url()).toBe(url);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the profile's last version comes back on the title page and in a plain play", async () => {
  // Leaving ends the session, which records the version it played.
  await page.goto(`/title/${movieId}`);
  await expect(page.getByRole("button", { name: "Version" })).toContainText("Remastered");

  const before = streams.length;

  await page.goto(`/watch/${movieId}?start=0`);
  await expectPlayingPast(page, 0.5);
  await expect.poll(() => streams.slice(before).at(-1)?.height).toBe(720);
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
});

test("an episode with two files offers both, on the show's page and in the player", async () => {
  await page.goto(`/title/${showId}`);

  const select = page.getByRole("button", { name: "Version" });

  await expect(select).toContainText("SD H.264");
  await select.click();
  await expect(page.getByRole("menuitemradio", { name: /^720p/u })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/watch/${showId}?episodeId=${await firstEpisode()}&start=0`);
  await expectPlayingPast(page, 0.5);
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(versionGroup(page).getByRole("radio")).toHaveCount(2);
});
