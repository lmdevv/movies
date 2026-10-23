import { join } from "node:path";

import type { TitleId } from "@movies/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { recordStreams } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";
import {
  encodeClip,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  scanLibrary,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

const SETUP_TIMEOUT_MS = 180_000;

const TEST_TIMEOUT_MS = 120_000;

/** Shorter than the pause below by more than the idle reaper's tick. */
const STREAM_IDLE_SECONDS = 5;

const PAUSE_MS = 15_000;

/** Enough forward buffer that hls.js has nothing left to fetch while paused. */
const BUFFERED_AHEAD_SECONDS = 20;

const MOVIE = "Harbor Night Watch";

const run = Date.now().toString(36);

/** One answer the media service gave for a file of an HLS stream. */
interface HlsResponse {
  readonly streamId: string;
  readonly generation: number;
  readonly file: string;
  readonly status: number;
  /** `Date.now()` in the test when the answer arrived. */
  readonly at: number;
}

const HLS_FILE = /\/media\/hls\/(?<streamId>[^/]+)\/(?<generation>\d+)\/(?<file>[^/?]+)/u;

/** Records every HLS playlist, init, and segment answer the page receives, in order. */
const recordHls = (page: Page): ReadonlyArray<HlsResponse> => {
  const responses: Array<HlsResponse> = [];

  page.on("response", (response) => {
    const groups = HLS_FILE.exec(new URL(response.url()).pathname)?.groups;

    if (groups?.["streamId"] === undefined || groups["file"] === undefined) return;

    responses.push({
      streamId: groups["streamId"],
      generation: Number(groups["generation"]),
      file: groups["file"],
      status: response.status(),
      at: Date.now(),
    });
  });

  return responses;
};

const isSegment = (response: HlsResponse): boolean => response.file.endsWith(".m4s");

/** Seconds the `<video>` element holds ahead of its position. */
const bufferedAhead = (page: Page): Promise<number> =>
  page.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("The player is not a video");

    const ranges = Array.from({ length: element.buffered.length }, (_, index) => ({
      start: element.buffered.start(index),
      end: element.buffered.end(index),
    }));

    const current = ranges.find(
      (range) => range.start <= element.currentTime && element.currentTime <= range.end,
    );

    return current === undefined ? 0 : current.end - element.currentTime;
  });

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

let hls: ReadonlyArray<HlsResponse> = [];

let titleId: TitleId;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-liveness-");

  const films = join(workspace, "Films");
  const folder = join(films, `${MOVIE} (2022)`);

  await Promise.all([
    encodeClip(join(folder, `${MOVIE} (2022).mkv`), {
      seconds: 120,
      video: "h264",
      audio: [{ codec: "ac3", language: "eng" }],
    }),
    writeText(join(folder, "movie.nfo"), movieNfo(MOVIE, 2022)),
  ]);

  const quickIdle = offline(stack);

  buildMediaService();
  media = await startMediaService(
    {
      ...quickIdle,
      mediaEnv: { ...quickIdle.mediaEnv, STREAM_IDLE_SECONDS: String(STREAM_IDLE_SECONDS) },
    },
    [workspace],
  );
  owner = await signInOwner(stack);

  const libraryId = await scanLibrary(owner.sdk, {
    name: `Liveness films ${run}`,
    kind: "movies",
    root: films,
    access: "everyone",
  });

  const scanned = (await titlesByName(owner.sdk, libraryId)).get(MOVIE);

  if (scanned === undefined) throw new Error(`${MOVIE} was not scanned`);

  titleId = scanned;
  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  hls = recordHls(page);
  await useSession(page, owner);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await owner.sdk.dispose();
  await media?.stop();
  await removePath(workspace);
});

test("a paused viewer resumes on the same stream after the media service's idle time", async () => {
  test.fail();
  test.setTimeout(TEST_TIMEOUT_MS);

  await page.goto(`/watch/${titleId}?start=0`);
  await expectPlayingPast(page, 1);
  await expect.poll(() => streams.at(-1)?.mode).toBe("audio-transcode");

  const streamId = streams.at(-1)?.streamId;

  if (streamId === undefined) throw new Error("The audio transcode has no stream id");

  await expect
    .poll(() => bufferedAhead(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(BUFFERED_AHEAD_SECONDS);
  expect(hls.filter(isSegment).map((response) => response.streamId)).toContain(streamId);

  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const pausedAt = Date.now();
  const pausedPosition = (await videoState(page)).currentTime;

  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

  const resumedAt = Date.now();

  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);

  await expect
    .poll(() => hls.filter((response) => response.at >= resumedAt && isSegment(response)).length, {
      message: "the resumed player fetches segments past its buffer",
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(3);

  const afterPause = hls.filter((response) => response.at >= pausedAt);

  expect(
    afterPause
      .filter((response) => response.status !== 200 || response.streamId !== streamId)
      .map(
        ({ streamId: id, generation, file, status }) =>
          `${String(status)} ${id}/${String(generation)}/${file}`,
      ),
    `every HLS answer after the pause is a 200 on stream ${streamId}`,
  ).toEqual([]);
  expect(
    streams.map((stream) => stream.streamId),
    "the player negotiated no other stream",
  ).toEqual([streamId]);
  await expectPlayingPast(page, pausedPosition + 10, 30_000);
});
