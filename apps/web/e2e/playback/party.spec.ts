/**
 * Moving a watch room on to the next episode, with a host and two guests in three browsers: the
 * owner hosts, Sam (a member without the private library) and the owner's second device follow.
 * The host's credits start one countdown every member sees, a guest's Close hides only their card
 * and a reload picks the countdown up again, and the room moves on together, in the room. The
 * host's Play next racing a second Play next, ⌘K's Next episode, and the Episodes picker move it on
 * once; guests get none of them. Watch credits cancels for everyone; the last episode shows no
 * card; a next episode whose file is missing says so to the host only; and a guest whose profile
 * cannot see what the room moved to keeps their place until it comes back.
 */
import { join } from "node:path";

import type { EpisodeId, LibraryId, RoomId, TitleId } from "@movies/contracts/ids";
import { RoomId as RoomIdSchema } from "@movies/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { drawStill } from "../stack/fixture-library";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { OWNER, createInvite } from "../stack/owner";
import {
  adultProfile,
  capture,
  commandMenu,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
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

/** Encoding the clips and bundling the service take a while on a cold machine. */
const SETUP_TIMEOUT_MS = 240_000;

/** A countdown, a move to the next episode, and three players opening it. */
const MOVE_ON_TIMEOUT_MS = 40_000;

const run = Date.now().toString(36);

const SHOW = "Tide Party";

/** The show's episodes by season, in order; the last has no next episode. */
const EPISODES = [
  { season: 1, episode: 1, name: "Ebb" },
  { season: 1, episode: 2, name: "Flood" },
  { season: 2, episode: 1, name: "Neap" },
  { season: 2, episode: 2, name: "Spring" },
] as const;

/** A show whose second episode's file goes missing after the scan. */
const DRIFT = "Drift Line";

/** The private film Sam's profile cannot see. */
const PRIVATE = "Quiet Hours";

/** How long each episode runs; its credits are the last four seconds. */
const EPISODE_SECONDS = 40;

const GUEST = { name: "Sam", email: `sam-party-${run}@movies.test`, password: "sam-password-1" };

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let member: Client;

let contexts: ReadonlyArray<BrowserContext> = [];

let host: Page;

/** Sam, a member: no grant to the private library. */
let sam: Page;

/** The owner's second device, which may see everything the host may. */
let second: Page;

let roomId: RoomId;

let showLibrary: LibraryId;

const titles = new Map<string, TitleId>();

/** The show's episode ids by name. */
const episodes = new Map<string, EpisodeId>();

let driftEpisodes: ReadonlyArray<EpisodeId> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-party-");

  const shows = join(workspace, "Shows");
  const restricted = join(workspace, "Private");
  const show = join(shows, `${SHOW} (2022)`);
  const drift = join(shows, `${DRIFT} (2023)`);
  const privateFolder = join(restricted, `${PRIVATE} (2019)`);
  const clip = { seconds: EPISODE_SECONDS, video: "h264", audio: [] } as const;

  await Promise.all([
    writeText(join(show, "tvshow.nfo"), showNfo(SHOW, 2022)),
    ...EPISODES.flatMap(({ season, episode, name }) => {
      const stem = join(
        show,
        `Season 0${String(season)}`,
        `${SHOW} - S0${String(season)}E0${String(episode)}`,
      );

      return [
        encodeClip(`${stem}.mp4`, { ...clip, audio: [{ codec: "aac", language: "eng" }] }),
        writeText(
          `${stem}.nfo`,
          episodeNfo(season, episode, name, {
            plot: `${name}: the harbor turns with the tide.`,
            runtimeMinutes: 42,
          }),
        ),
        drawStill(browser, name, `${stem}-thumb.jpg`),
      ];
    }),
    writeText(join(drift, "tvshow.nfo"), showNfo(DRIFT, 2023)),
    ...[1, 2].flatMap((episode) => {
      const stem = join(drift, "Season 01", `${DRIFT} - S01E0${String(episode)}`);

      return [
        encodeClip(`${stem}.mp4`, { ...clip, audio: [{ codec: "aac", language: "eng" }] }),
        writeText(`${stem}.nfo`, episodeNfo(1, episode, `Drift ${String(episode)}`)),
      ];
    }),
    encodeClip(join(privateFolder, `${PRIVATE} (2019).mp4`), {
      ...clip,
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(privateFolder, "movie.nfo"), movieNfo(PRIVATE, 2019)),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const [showsId, privateId] = await Promise.all([
    scanLibrary(owner.sdk, {
      name: `Party shows ${run}`,
      kind: "shows",
      root: shows,
      access: "everyone",
    }),
    // Members see a restricted library only when an admin grants it; Sam has no grant.
    scanLibrary(owner.sdk, {
      name: `Party private ${run}`,
      kind: "movies",
      root: restricted,
      access: "restricted",
    }),
  ]);

  showLibrary = showsId;

  const scanned = await Promise.all([showsId, privateId].map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

  const profile = await adultProfile(owner.sdk);

  const seasons = await Promise.all(
    [1, 2].map((seasonNumber) =>
      owner.sdk.query("titles.episodes", {
        profileId: profile.id,
        titleId: titleId(SHOW),
        seasonNumber,
      }),
    ),
  );

  for (const each of seasons.flat()) episodes.set(each.name, each.id);

  driftEpisodes = (
    await owner.sdk.query("titles.episodes", {
      profileId: profile.id,
      titleId: titleId(DRIFT),
      seasonNumber: 1,
    })
  ).map((each) => each.id);

  // The drift show's second file goes missing, and a scan marks it so.
  await removePath(join(drift, "Season 01", `${DRIFT} - S01E02.mp4`));

  const rescan = await owner.sdk.mutate("libraries.scan", { libraryId: showLibrary });

  await expect
    .poll(async () => (await owner.sdk.query("jobs.get", { jobId: rescan.jobId })).status, {
      timeout: 60_000,
    })
    .toBe("succeeded");

  const { invite } = await createInvite(stack, OWNER);

  member = openClient(stack);
  await member.sdk.auth.signInWithPassword({
    flow: "signUp",
    email: GUEST.email,
    password: GUEST.password,
    name: GUEST.name,
    inviteCode: invite.code,
  });

  contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);

  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [hostPage, samPage, secondPage] = pages;

  if (hostPage === undefined || samPage === undefined || secondPage === undefined) {
    throw new Error("The browsers did not open");
  }

  host = hostPage;
  sam = samPage;
  second = secondPage;
  await Promise.all([useSession(host, owner), useSession(sam, member), useSession(second, owner)]);
});

test.afterAll(async () => {
  if (stack === null) return;

  await Promise.all(contexts.map((context) => context.close()));
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

function episodeId(name: string): EpisodeId {
  const id = episodes.get(name);

  if (id === undefined) throw new Error(`${SHOW} has no episode ${name}`);

  return id;
}

const guests = (): ReadonlyArray<Page> => [sam, second];

const everyone = (): ReadonlyArray<Page> => [host, sam, second];

/** A page's next-episode card. */
const card = (page: Page) => page.getByRole("region", { name: "Next episode" });

/** The seconds a page's card shows. */
const secondsOn = async (page: Page): Promise<number> =>
  Number(await card(page).locator('[data-slot="countdown-seconds"]').textContent());

/** The room as the server has it now. */
const roomNow = () => owner.sdk.query("rooms.get", { roomId });

/** Every page plays `name` in the room, past half a second. */
const expectEveryoneOn = async (name: string): Promise<void> => {
  const into = new RegExp(`episodeId=${episodeId(name)}`, "u");

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(into, { timeout: MOVE_ON_TIMEOUT_MS });
      await expect(page).toHaveURL(new RegExp(`room=${roomId}`, "u"));
      await expectPlayingPast(page, 0.5);
    }),
  );
};

/** The host seeks to the end of the episode, into the credits, where the countdown starts. */
const hostToCredits = async (): Promise<void> => {
  await expectPlayingPast(host, 0.5);

  const player = host.getByTestId("player");

  await player.press("l");
  await player.press("l");
  await player.press("l");
  await player.press("ArrowRight");
  await player.press("ArrowRight");
  await expect
    .poll(async () => (await videoState(host)).currentTime)
    .toBeGreaterThan(EPISODE_SECONDS - 2);
};

test("the host starts a room on the first episode and two guests join it", async () => {
  await host.goto(`/watch/${titleId(SHOW)}?episodeId=${episodeId("Ebb")}&start=0`);
  await expectPlayingPast(host, 0.5);
  await revealControls(host);
  await host.getByRole("button", { name: "Watch together" }).click();
  await host
    .getByRole("dialog", { name: "Watch together" })
    .getByRole("button", { name: "Start room" })
    .click();
  await expect(host).toHaveURL(/[?&]room=/u);
  roomId = Schema.decodeSync(RoomIdSchema)(new URL(host.url()).searchParams.get("room") ?? "");

  await Promise.all(guests().map((page) => page.goto(`/r/${roomId}`)));
  await Promise.all(guests().map((page) => expectPlayingPast(page, 0.5)));
  await expect(host.getByText("Live · 3 watching")).toBeVisible({ timeout: 15_000 });

  // Guests have no Next episode or Episodes control; the host has both.
  await revealControls(host);
  await expect(host.getByRole("button", { name: "Next episode" })).toBeVisible();
  await expect(host.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();

  await Promise.all(
    guests().map(async (page) => {
      await revealControls(page);
      await expect(page.getByRole("button", { name: "Next episode" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
    }),
  );
});

test("the host's credits start one countdown everyone sees, and the room moves on together", async () => {
  await hostToCredits();

  // One countdown, at one server time: every member's card counts the same seconds.
  await Promise.all(everyone().map((page) => expect(card(page)).toBeVisible()));
  await expect(card(host).getByRole("button", { name: "Play next" })).toBeFocused();
  await expect(card(host).getByRole("button", { name: "Watch credits" })).toBeVisible();

  await Promise.all(
    guests().map(async (page) => {
      await expect(card(page).getByRole("button", { name: "Play next" })).toHaveCount(0);
      await expect(card(page).getByRole("timer")).toHaveAccessibleName(/^Starts in \d+ seconds?$/u);
      await expect(card(page).getByRole("heading", { name: "Flood" })).toBeVisible();
    }),
  );

  const shown = await Promise.all(everyone().map(secondsOn));

  expect(Math.max(...shown) - Math.min(...shown)).toBeLessThanOrEqual(1);

  const room = await roomNow();

  expect(room.next).toMatchObject({ status: "pending", episode: { id: episodeId("Flood") } });
  await capture(host, "08-20-party-host-card");
  await capture(sam, "08-21-party-guest-card");

  // Sam's Close hides only Sam's card; the countdown runs on for everyone else.
  await card(sam).getByRole("button", { name: "Close" }).click();
  await expect(card(sam)).toBeHidden();
  await capture(sam, "08-22-party-guest-closed");
  await expect(card(second)).toBeVisible();
  expect((await roomNow()).next).toMatchObject({ status: "pending" });

  // A guest who reloads mid-countdown picks it up where everyone else is.
  await second.reload();
  await expect(card(second)).toBeVisible({ timeout: 15_000 });
  expect(Math.abs((await secondsOn(second)) - (await secondsOn(host)))).toBeLessThanOrEqual(1);

  await expectEveryoneOn("Flood");

  // The same room, link, and members, on the next episode, without a countdown.
  const moved = await roomNow();

  expect(moved.id).toBe(roomId);
  expect(moved.episode?.id).toBe(episodeId("Flood"));
  expect(moved.next).toBeNull();
  expect(moved.members).toHaveLength(3);
});

test("the host's Play next racing another moves the room on once, into the next season", async () => {
  await hostToCredits();
  await expect(card(host)).toBeVisible();

  const before = await roomNow();

  // The card's Play next sends its move without waiting for it; two more from the same episode, as
  // a double click or a stale tab sends them, race it. All name the episode they move on from, so
  // the room moves on once.
  const fromFlood = { roomId, deviceId: before.hostDeviceId, fromEpisodeId: episodeId("Flood") };

  await card(host).getByRole("button", { name: "Play next" }).click({ timeout: 5_000 });
  await Promise.all([
    owner.sdk.mutate("rooms.playNext", fromFlood),
    owner.sdk.mutate("rooms.playNext", fromFlood),
  ]);
  await expectEveryoneOn("Neap");
  expect((await owner.sdk.mutate("rooms.playNext", fromFlood)).episode?.id).toBe(episodeId("Neap"));
  expect((await roomNow()).episode?.id).toBe(episodeId("Neap"));
});

test("Watch credits cancels the countdown for everyone, and the room stays on the episode", async () => {
  await hostToCredits();
  await Promise.all(everyone().map((page) => expect(card(page)).toBeVisible()));
  await card(host).getByRole("button", { name: "Watch credits" }).click();
  await Promise.all(everyone().map((page) => expect(card(page)).toBeHidden()));
  expect((await roomNow()).next).toStrictEqual({ status: "cancelled" });

  // Past when the countdown would have ended, everyone is still on this episode.
  await host.waitForTimeout(12_000);
  expect((await roomNow()).episode?.id).toBe(episodeId("Neap"));

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(new RegExp(`episodeId=${episodeId("Neap")}`, "u"));
      await expect(card(page)).toBeHidden();
    }),
  );
});

test("⌘K's Next episode is the host's alone, and moves the whole room on", async () => {
  const ofSam = commandMenu(sam);

  await sam.keyboard.press("ControlOrMeta+k");
  await expect(ofSam.playback.getByRole("option", { name: /^Subtitles/u })).toBeVisible();
  await expect(ofSam.playback.getByRole("option", { name: /^Next episode/u })).toHaveCount(0);
  await expect(ofSam.playback.getByRole("option", { name: /^Episodes/u })).toHaveCount(0);
  await sam.keyboard.press("Escape");
  await expect(ofSam.menu).toBeHidden();

  const ofHost = commandMenu(host);

  await host.keyboard.press("ControlOrMeta+k");
  await ofHost.playback.getByRole("option", { name: /^Next episode/u }).click();
  await expectEveryoneOn("Spring");
});

test("the last episode shows no card, and the host's Episodes picker moves the room back", async () => {
  await hostToCredits();
  // Past the end of the last episode: nothing to count down to, for anyone.
  await host.waitForTimeout(4_000);

  await Promise.all(everyone().map((page) => expect(card(page)).toHaveCount(0)));
  expect((await roomNow()).next).toBeNull();

  await revealControls(host);
  await host.getByRole("button", { name: "Episodes", exact: true }).click();

  const picker = host.getByRole("dialog", { name: "Episodes" });

  await picker.getByRole("button", { name: "Season 1", exact: true }).click();
  await picker.locator('[data-slot="episode-row"]').filter({ hasText: "Ebb" }).click();
  await expectEveryoneOn("Ebb");
  expect((await roomNow()).next).toBeNull();
});

test("a next episode whose file is missing tells the host, and only the host", async () => {
  const before = await roomNow();
  const [first] = driftEpisodes;

  if (first === undefined) throw new Error(`${DRIFT} has no episodes`);

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: before.hostDeviceId,
    revision: before.clock.revision,
    titleId: titleId(DRIFT),
    episodeId: first,
  });

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(new RegExp(`/watch/${titleId(DRIFT)}\\?`, "u"), {
        timeout: MOVE_ON_TIMEOUT_MS,
      });
      await expectPlayingPast(page, 0.5);
    }),
  );
  await hostToCredits();

  const missing = card(host);

  await expect(missing.locator('[data-slot="next-episode-reason"]')).toHaveText("File missing");
  await expect(missing.getByRole("button", { name: "Play next" })).toHaveCount(0);
  await capture(host, "08-24-party-file-missing");
  await host.waitForTimeout(2_000);

  await Promise.all(guests().map((page) => expect(card(page)).toHaveCount(0)));
  expect((await roomNow()).next).toBeNull();
  await missing.getByRole("button", { name: "Close" }).click();
  await expect(missing).toBeHidden();
});

test("a guest whose profile cannot see what the room moved to keeps their place until it comes back", async () => {
  const before = await roomNow();

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: before.hostDeviceId,
    revision: before.clock.revision,
    titleId: titleId(PRIVATE),
  });

  // Sam's profile has no grant to the private library: no player, and no hint of what plays.
  await expect(sam.getByRole("heading", { name: "Not available on this profile" })).toBeVisible({
    timeout: MOVE_ON_TIMEOUT_MS,
  });
  await expect(sam.getByText(PRIVATE)).toHaveCount(0);
  await capture(sam, "08-23-party-not-available");

  // The owner's second device follows; Sam keeps a place in the room, away.
  await expect(second).toHaveURL(new RegExp(`/watch/${titleId(PRIVATE)}\\?room=${roomId}`, "u"), {
    timeout: MOVE_ON_TIMEOUT_MS,
  });
  await expectPlayingPast(second, 0.5);
  await expect
    .poll(
      async () =>
        (await roomNow()).members.find((each) => each.profileName === GUEST.name)?.presence,
      { timeout: 30_000 },
    )
    .toBe("away");

  // Back on the show, Sam's player opens it again, in the room.
  const moved = await roomNow();

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: moved.hostDeviceId,
    revision: moved.clock.revision,
    titleId: titleId(SHOW),
    episodeId: episodeId("Flood"),
  });
  await expectEveryoneOn("Flood");
});
