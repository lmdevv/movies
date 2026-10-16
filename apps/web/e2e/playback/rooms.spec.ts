/**
 * Join watching with two browsers: the owner hosts and an invited member follows with a stream of
 * their own. A late guest lands on the live position; the host's pause and seek reach the guest;
 * the guest's controls are locked and the server refuses their commands; the host's stall holds
 * the guest; a guest who stalls catches up without moving the host; the host going away pauses
 * the room; and room links say why they cannot be joined. The film remuxes to HLS, so the suite
 * can hold segment requests to stall a player. Settled drift goes to the test's annotations.
 */
import { join } from "node:path";

import { HEARTBEAT_INTERVAL_MS } from "@movies/contracts/clock";
import { DeviceId, RoomId } from "@movies/contracts/ids";
import type { TitleId } from "@movies/contracts/ids";
import { Milliseconds } from "@movies/contracts/units";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { OWNER, createInvite } from "../stack/owner";
import {
  adultProfile,
  capture,
  clickScrubber,
  commandMenu,
  driftMs,
  encodeClip,
  expectPlayingPast,
  leaveDialog,
  leaveWithEscape,
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

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Encoding the clips and bundling the service take a while on a cold machine. */
const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const SHARED = "Harbor Lights";

const PRIVATE = "Quiet Hours";

/** How long the shared film runs; long enough that seeks land far outside what is buffered. */
const FILM_SECONDS = 360;

/**
 * A settled guest is this close to the host: the engine settles it within 30 ms of the room clock,
 * and the host's heartbeat keeps the clock within 50 ms of the host. The rest is for reading two
 * pages one after the other on a loaded machine.
 */
const SETTLED_MS = 150;

/**
 * How long after first coming within `SETTLED_MS` the drift is read again: the guest is often still
 * nudging then, and the host's next heartbeat may still re-anchor the clock. Two heartbeats cover
 * both, so the second reading shows where the guest ends up, and that it stayed.
 */
const REPORT_AFTER_MS = 2 * HEARTBEAT_INTERVAL_MS;

const GUEST = { name: "Sam", email: `sam-rooms-${run}@movies.test`, password: "sam-password-1" };

/** HLS media segments; playlists, init segments, and API calls go through. */
const SEGMENTS = /\/media\/hls\/[^/]+\/\d+\/\d+\.m4s/u;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let member: Client;

let hostContext: BrowserContext;

let guestContext: BrowserContext;

let host: Page;

let guest: Page;

let roomId: RoomId;

const titles = new Map<string, TitleId>();

/**
 * Drift samples after settling, reported once the suite ends. `guestReportedMs` is the drift the
 * guest's engine last reported against the room clock as it estimates it; a gap between the two
 * is that estimate's error.
 */
const drifts: Array<{
  readonly when: string;
  readonly ms: number;
  readonly guestReportedMs: number | null;
}> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-rooms-");

  const shared = join(workspace, "Shared");
  const restricted = join(workspace, "Private");
  const sharedFolder = join(shared, `${SHARED} (2020)`);
  const privateFolder = join(restricted, `${PRIVATE} (2019)`);

  await Promise.all([
    encodeClip(join(sharedFolder, `${SHARED} (2020).ts`), {
      seconds: FILM_SECONDS,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(sharedFolder, "movie.nfo"), movieNfo(SHARED, 2020)),
    encodeClip(join(privateFolder, `${PRIVATE} (2019).mp4`), {
      seconds: 20,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(privateFolder, "movie.nfo"), movieNfo(PRIVATE, 2019)),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const libraries = await Promise.all([
    scanLibrary(owner.sdk, {
      name: `Shared films ${run}`,
      kind: "movies",
      root: shared,
      access: "everyone",
    }),
    // Members see a restricted library only when an admin grants it; Sam has no grant.
    scanLibrary(owner.sdk, {
      name: `Private films ${run}`,
      kind: "movies",
      root: restricted,
      access: "restricted",
    }),
  ]);

  const scanned = await Promise.all(libraries.map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

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
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await useSession(host, owner);
  await useSession(guest, member);
});

test.afterAll(async () => {
  if (stack === null) return;

  test.info().annotations.push({
    type: "drift",
    description: drifts
      .map(
        ({ when, ms, guestReportedMs }) =>
          `${when} ${String(ms)} ms (guest ${String(guestReportedMs)})`,
      )
      .join(", "),
  });

  // The numbers the milestone report quotes.
  console.log(`Room drift after settling: ${JSON.stringify(drifts)}`);
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

/** Waits until the guest is within `SETTLED_MS` of the host, then checks and records it stays. */
const expectSettled = async (when: string): Promise<void> => {
  await expect
    .poll(async () => Math.abs(await driftMs(host, guest)), { timeout: 30_000 })
    .toBeLessThanOrEqual(SETTLED_MS);
  await host.waitForTimeout(REPORT_AFTER_MS);

  const settled = await driftMs(host, guest);

  const room = await owner.sdk.query("rooms.get", { roomId });

  const guestReportedMs =
    room.members.find((each) => each.profileName === GUEST.name)?.driftMs ?? null;

  drifts.push({ when, ms: settled, guestReportedMs });
  expect(Math.abs(settled)).toBeLessThanOrEqual(SETTLED_MS);
};

/** Holds `page`'s HLS segment requests until the returned function releases them. */
const holdSegments = async (page: Page): Promise<() => Promise<void>> => {
  const held: Array<Route> = [];
  let holding = true;

  const handler = async (route: Route): Promise<void> => {
    if (holding) {
      held.push(route);

      return;
    }

    await route.continue();
  };

  await page.route(SEGMENTS, handler);

  return async () => {
    holding = false;
    await page.unroute(SEGMENTS, handler);
    // A request the player gave up on while held fails to continue; it is no longer wanted.
    await Promise.all(held.map((route) => route.continue().catch(() => undefined)));
  };
};

/** Opens Watch together from the player's controls and starts the room. */
const startRoom = async (page: Page): Promise<RoomId> => {
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();

  const dialog = page.getByRole("dialog", { name: "Watch together" });

  await expect(dialog.getByLabel("Room link")).toContainText("/r/");
  await capture(page, "08-01-start-a-room");
  await dialog.getByRole("button", { name: "Start room" }).click();
  await expect(page).toHaveURL(/[?&]room=/u);

  const id = new URL(page.url()).searchParams.get("room");

  if (id === null) throw new Error("The player did not join the room it started");

  return Schema.decodeSync(RoomId)(id);
};

const guestDeviceId = async () => {
  const room = await owner.sdk.query("rooms.get", { roomId });
  const self = room.members.find((each) => each.profileName === GUEST.name);

  if (self === undefined) throw new Error(`${GUEST.name} is not in the room`);

  return { deviceId: self.deviceId, revision: room.clock.revision };
};

test("the host starts a room and a late guest lands on the live position", async () => {
  await host.goto(`/watch/${titleId(SHARED)}?start=0`);
  await expectPlayingPast(host, 3);
  roomId = await startRoom(host);
  await expect(host.getByText("Live · 1 watching")).toBeVisible();

  // The guest opens the link a few seconds into the room.
  await expectPlayingPast(host, 8);
  await guest.goto(`/r/${roomId}`);
  await expect(guest).toHaveURL(new RegExp(`/watch/${titleId(SHARED)}\\?room=${roomId}`, "u"));
  await expectPlayingPast(guest, 8);
  await expectSettled("late join");

  await expect(host.getByText("Live · 2 watching")).toBeVisible();
  await expect(
    host.getByRole("region", { name: "Watching together" }).getByText(GUEST.name),
  ).toBeVisible();
  await revealControls(host);
  await capture(host, "08-02-host-view");
});

test("the host's pause and seek reach the guest", async () => {
  await host.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(true);
  await expect(guest.getByText("Room paused · 2 watching")).toBeVisible();

  const paused = await videoState(host);

  await expect
    .poll(async () => Math.abs((await videoState(guest)).currentTime - paused.currentTime))
    .toBeLessThanOrEqual(SETTLED_MS / 1000);

  // A seek while paused moves the guest and keeps everyone paused.
  await host.getByTestId("player").press("l");
  await expect
    .poll(async () => (await videoState(guest)).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(paused.currentTime + 8);
  expect((await videoState(guest)).paused).toBe(true);

  await host.getByTestId("player").press(" ");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(false);
  await expectSettled("after host seek and play");
});

test("a guest's controls are locked, and the server refuses a guest's command", async () => {
  await revealControls(guest);
  await expect(guest.getByText(`Only ${OWNER.name} can pause or seek`)).toBeVisible();
  await capture(guest, "08-04-guest-view");

  const before = await videoState(guest);

  await guest.getByTestId("player").press(" ");
  await guest.getByTestId("player").press("l");
  await guest.waitForTimeout(1_000);

  const after = await videoState(guest);

  expect(after.paused).toBe(false);
  expect(after.currentTime - before.currentTime).toBeLessThan(3);
  expect((await videoState(host)).paused).toBe(false);

  const { deviceId, revision } = await guestDeviceId();

  await expect(
    member.sdk.mutate("rooms.pause", {
      roomId,
      deviceId,
      revision,
      positionMs: Milliseconds.make(0),
    }),
  ).rejects.toHaveProperty("_tag", "Forbidden");
});

test("⌘K and Escape in a room: each side gets its own commands, and asking never pauses the room", async () => {
  const onRoom = new RegExp(`[?&]room=${roomId}`, "u");

  // The guest follows the timeline, so their menu has tracks but no transport, and no End room.
  const ofGuest = commandMenu(guest);

  await guest.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [/^Subtitles/u, /^Audio/u, /^Quality/u, /^Stream info/u, /^Full screen/u].map((name) =>
      expect(ofGuest.playback.getByRole("option", { name })).toBeVisible(),
    ),
  );

  await expect(ofGuest.playback.getByRole("option", { name: /^(Pause|Play)\b/u })).toHaveCount(0);
  await expect(ofGuest.playback.getByRole("option", { name: /^Back 10 seconds/u })).toHaveCount(0);

  const guestRoom = ofGuest.menu.getByRole("group", { name: "Room" });

  await expect(guestRoom.getByRole("option", { name: /^Copy room link/u })).toBeVisible();
  await expect(guestRoom.getByRole("option", { name: /^Leave room/u })).toBeVisible();
  await expect(guestRoom.getByRole("option", { name: /^End room/u })).toHaveCount(0);
  await capture(guest, "08-08-guest-command-menu");
  await guest.keyboard.press("Escape");
  await expect(ofGuest.menu).toBeHidden();

  // The host moves the timeline and ends the room; leaving it is the guest's command.
  const ofHost = commandMenu(host);

  await host.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [/^Pause/u, /^Back 10 seconds/u, /^Subtitles/u, /^Audio/u, /^Quality/u].map((name) =>
      expect(ofHost.playback.getByRole("option", { name })).toBeVisible(),
    ),
  );

  const hostRoom = ofHost.menu.getByRole("group", { name: "Room" });

  await expect(hostRoom.getByRole("option", { name: /^Copy room link/u })).toBeVisible();
  await expect(hostRoom.getByRole("option", { name: /^End room/u })).toBeVisible();
  await expect(hostRoom.getByRole("option", { name: /^Leave room/u })).toHaveCount(0);
  await host.keyboard.press("Escape");
  await expect(ofHost.menu).toBeHidden();

  // Escape asks on both sides without pausing anyone, and Stay keeps everyone in the room.
  const askThenStay = async (page: Page, other: Page): Promise<void> => {
    await page.getByTestId("player").press("Escape");
    await expect(leaveDialog(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect((await videoState(page)).paused).toBe(false);
    expect((await videoState(other)).paused).toBe(false);
    expect((await owner.sdk.query("rooms.get", { roomId })).clock.status).toBe("playing");
    await leaveDialog(page).getByRole("button", { name: "Stay" }).click();
    await expect(leaveDialog(page)).toBeHidden();
    await expect(page).toHaveURL(onRoom);
  };

  await askThenStay(guest, host);
  await askThenStay(host, guest);

  // A guest who leaves playback leaves the room playing for the host, and can come back.
  await leaveWithEscape(guest);
  await expect(guest).toHaveURL(new RegExp(`/title/${titleId(SHARED)}$`, "u"));
  await host.waitForTimeout(1_000);
  expect((await videoState(host)).paused).toBe(false);
  await expect(host).toHaveURL(onRoom);
  expect((await owner.sdk.query("rooms.get", { roomId })).clock.status).toBe("playing");
  await guest.goto(`/r/${roomId}`);
  await expect(guest).toHaveURL(onRoom);
  await expectSettled("after the guest came back");
});

test("the host's stall holds the guest until the host plays again", async () => {
  const release = await holdSegments(host);

  // A seek far ahead needs segments the host cannot get.
  await clickScrubber(host, 0.8);
  await expect(guest.getByText(`Waiting for ${OWNER.name}'s connection`)).toBeVisible({
    timeout: 15_000,
  });
  // The guest's stream moves too: its element reads paused at 0 until the new segments load.
  await expect
    .poll(
      async () => {
        const state = await videoState(guest);

        return state.paused && state.currentTime > FILM_SECONDS * 0.7;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await capture(guest, "08-05-host-buffering");

  await release();
  await expect(guest.getByText(`Waiting for ${OWNER.name}'s connection`)).toBeHidden({
    timeout: 20_000,
  });
  await expectPlayingPast(host, FILM_SECONDS * 0.8);
  await expectPlayingPast(guest, FILM_SECONDS * 0.8);
  await expectSettled("after host stall");
});

test("a guest who stalls catches up without moving the host", async () => {
  // Back to an early position, so the rest of the suite has film left to play.
  await clickScrubber(host, 0.1);
  await expectSettled("after host seek back");

  const release = await holdSegments(guest);
  const hostBefore = await videoState(host);

  // The guest reloads and cannot load a segment; the room plays on.
  await guest.reload();
  await expect(guest.getByText(`Syncing to ${OWNER.name}`)).toBeVisible({ timeout: 15_000 });
  await capture(guest, "08-03-guest-joining");
  await guest.waitForTimeout(4_000);

  const hostDuring = await videoState(host);

  expect(hostDuring.paused).toBe(false);
  expect(hostDuring.currentTime - hostBefore.currentTime).toBeGreaterThan(3);
  await expect(host.getByText("Live · 2 watching")).toBeVisible();

  await release();
  await expectPlayingPast(guest, hostDuring.currentTime);
  await expectSettled("after guest stall");
});

test("the host going away pauses the room for the guest, who can keep watching alone", async () => {
  test.setTimeout(90_000);
  await host.close();

  // The server marks a host away after twenty silent seconds and pauses the room.
  await expect(guest.getByRole("heading", { name: `${OWNER.name} left the room` })).toBeVisible({
    timeout: 45_000,
  });
  await expect(guest.getByText(/^Paused for everyone at \d+:\d\d\.$/u)).toBeVisible();
  await capture(guest, "08-06-host-left");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(true);

  const stopped = (await videoState(guest)).currentTime;

  await guest.getByRole("button", { name: "Keep watching on my own" }).click();
  await expect(guest).not.toHaveURL(/[?&]room=/u);
  await expectPlayingPast(guest, stopped + 1);
});

test("an ended room and another household's room deny their links", async ({
  browser,
}: {
  readonly browser: Browser;
}) => {
  host = await hostContext.newPage();
  await host.goto(`/watch/${titleId(SHARED)}?start=0`);
  await expectPlayingPast(host, 1);

  const second = await startRoom(host);

  await guest.goto(`/r/${second}`);
  await expectPlayingPast(guest, 1);
  await host.getByRole("button", { name: "End room" }).click();
  await expect(host).not.toHaveURL(/[?&]room=/u);

  // The host's stream plays on after the room ends.
  const ended = (await videoState(host)).currentTime;

  await expectPlayingPast(host, ended + 1);
  await expect(guest.getByRole("heading", { name: `${OWNER.name} left the room` })).toBeVisible({
    timeout: 15_000,
  });

  await guest.goto(`/r/${second}`);
  await expect(guest.getByRole("heading", { name: "This room has ended" })).toBeVisible();
  await expect(guest.getByText(`${OWNER.name} closed this room.`)).toBeVisible();
  await capture(guest, "08-07a-join-denied-ended");

  // A room playing a title the member's account cannot see.
  const profile = await adultProfile(owner.sdk);

  const hidden = await owner.sdk.mutate("rooms.create", {
    profileId: profile.id,
    deviceId: Schema.decodeSync(DeviceId)(`e2e-${run}`),
    titleId: titleId(PRIVATE),
    positionMs: Milliseconds.make(0),
  });

  const stranger = await browser.newContext();
  const visitor = await stranger.newPage();

  await useSession(visitor, member);
  await visitor.goto(`/r/${hidden.id}`);
  await expect(
    visitor.getByRole("heading", { name: "This room is for another household" }),
  ).toBeVisible();
  await capture(visitor, "08-07b-join-denied-household");
  await stranger.close();
});
