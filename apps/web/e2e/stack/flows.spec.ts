import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { plantExpiredInvite } from "./expired-invite";
import { MOVIE_COUNT, generateFixtureLibrary } from "./fixture-library";
import { freshStack } from "./fresh-stack";
import { buildMediaService, startMediaService } from "./media-service";
import type { MediaService } from "./media-service";
import { OWNER, createInvite } from "./owner";

const stack = await freshStack();

test.skip(stack === null, "needs a fresh dev stack: scripts/dev-stack.sh destroy && up");

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);

const owner = OWNER;

const mod = process.platform === "darwin" ? "Meta" : "Control";

const SETUP_TIMEOUT_MS = 180_000;

let context: BrowserContext;

let page: Page;

let media: MediaService | undefined;

let workspace = "";

let libraryRoot = "";

let nasRoot = "";

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-e2e-"));
  libraryRoot = join(workspace, "library");
  nasRoot = join(workspace, "nas");
  await mkdir(libraryRoot, { recursive: true });
  await generateFixtureLibrary(browser, join(libraryRoot, "Movies"), join(nasRoot, "Shows"));
  buildMediaService();
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

const restartMedia = async (roots: ReadonlyArray<string>): Promise<void> => {
  if (stack === null) return;

  await media?.stop();
  media = await startMediaService(stack, roots);
};

const openMenu = async (target: Page): Promise<void> => {
  await expect(target.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await target.keyboard.press(`${mod}+k`);
  await expect(target.getByRole("combobox")).toBeFocused();
};

const capture = async (target: Page, name: string): Promise<void> => {
  const folder = process.env["E2E_SCREENSHOTS"];

  if (folder === undefined || folder === "") return;

  await target.waitForLoadState("networkidle");
  await target.waitForTimeout(400);

  await target.getByRole("button", { name: /TanStack Router/u }).evaluateAll((buttons) => {
    for (const button of buttons) {
      if (button instanceof HTMLElement) button.style.visibility = "hidden";
    }
  });

  await target.screenshot({ path: `${folder}/${name}.png` });
};

const signIn = async (target: Page, email: string, password: string): Promise<void> => {
  await target.goto("/sign-in");
  await target.getByLabel("Email").fill(email);
  await target.getByLabel("Password", { exact: true }).fill(password);
  await target.getByRole("button", { name: "Sign in" }).click();
};

test("first run creates the owner, checks the folder, and shows the scan live", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/u);

  await page.getByLabel("Your name").fill(owner.name);
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await expect(page.getByText(`${owner.password.length} characters`)).toBeVisible();
  await capture(page, "03-01-welcome");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page).toHaveURL(/\/setup\/library$/u);

  await page.goto("/");
  await page.getByRole("button", { name: owner.name }).click();
  await expect(page.getByRole("heading", { name: "No libraries yet" })).toBeVisible();
  await capture(page, "05-06-empty-library");
  await page.getByRole("link", { name: "Add library" }).click();
  await expect(page).toHaveURL(/\/setup\/library$/u);

  const folder = page.getByLabel("Folder path", { exact: true });

  await folder.fill("media/movies");
  await page.getByRole("button", { name: "Save and start scan" }).click();
  await expect(page.getByText("Can't use this folder")).toBeVisible();
  await expect(page.getByText(/full path from the root/u)).toBeVisible();
  await capture(page, "03-02b-invalid-folder");

  await folder.fill(join(libraryRoot, "Movies"));
  await page.getByRole("button", { name: "Save and start scan" }).click();
  await expect(page).toHaveURL(/\/setup\/scan/u);
  await expect(page.getByRole("heading", { name: "Building your library." })).toBeVisible();

  await expect(page.getByText("waiting for the media service")).toBeVisible();

  const home = await context.newPage();

  await home.goto("/");

  const toast = home.getByRole("region", { name: "Library scan" });

  await expect(toast).toContainText("Scanning Movies");
  await expect(toast).toContainText("Waiting for the media service");
  await capture(home, "05-07-scanning");

  await restartMedia([libraryRoot]);
  await expect(toast).toHaveCount(0, { timeout: 30_000 });
  await home.close();

  await expect(page.getByText("100%")).toBeVisible();
  await expect(page.getByText(String(MOVIE_COUNT), { exact: true }).first()).toBeVisible();
  await capture(page, "03-03-first-scan");

  await page.getByRole("link", { name: "Continue to [movies]" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("region", { name: "Recently added" })).toBeVisible();
});

test("a scan of a folder the media service may not read fails, and retries once it may", async () => {
  const shows = join(nasRoot, "Shows");

  await page.goto("/setup/library");
  await page.getByRole("radio", { name: "Shows" }).click();
  await page.getByLabel("Folder path", { exact: true }).fill(shows);
  await page.getByRole("button", { name: "Save and start scan" }).click();
  await expect(page).toHaveURL(/\/setup\/scan/u);

  await expect(page.getByRole("heading", { name: "The scan stopped." })).toBeVisible();
  await expect(page.getByText(`${shows} is outside LIBRARY_ROOTS`, { exact: false })).toBeVisible();
  await capture(page, "03-03b-scan-failed");

  await restartMedia([libraryRoot, nasRoot]);
  await page.getByRole("button", { name: "Retry scan" }).click();
  await expect(page.getByRole("heading", { name: "Building your library." })).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible({ timeout: 30_000 });
});

test("home shows the library; a title opens, joins My List, and the keyboard navigates", async () => {
  await page.goto("/");

  const recent = page.getByRole("region", { name: "Recently added" });

  await expect(recent.getByRole("link", { name: "Arrival" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shows" })).toBeVisible();
  await capture(page, "05-01-home");

  await recent.getByRole("link", { name: "Arrival" }).click();
  await expect(page.getByRole("heading", { name: "ARRIVAL" })).toBeVisible();
  await expect(page.getByText("PG-13", { exact: true })).toBeVisible();
  await expect(page.getByText("HEVC", { exact: true })).toBeVisible();
  await capture(page, "05-02-movie");

  await page.getByRole("button", { name: "Add to My List" }).click();
  await expect(page.getByRole("button", { name: "Remove from My List" })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(/\/my-list$/u);
  await expect(page.getByRole("link", { name: /Arrival/u })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/shows$/u);
  await page.getByRole("link", { name: /Severance/u }).click();
  await expect(page.getByRole("region", { name: "Episodes" })).toBeVisible();
  await expect(page.getByText("Good News About Hell", { exact: true })).toBeVisible();
  await capture(page, "05-03-show");

  await openMenu(page);
  await capture(page, "12-01-menu");
  await page.getByRole("combobox").fill("Dune");
  await expect(
    page.getByRole("group", { name: "Titles" }).getByRole("option", { name: /Dune Part Two/u }),
  ).toBeVisible();
  await capture(page, "12-02-menu-search");
  await page.getByRole("combobox").fill("movies");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/movies$/u);
  await expect(page.getByRole("link", { name: /Sicario/u })).toBeVisible();
});

test("profiles: a kids profile and a PIN profile, with a wrong PIN", async ({ browser }) => {
  await page.goto("/profiles/new");
  await page.getByLabel("Name").fill("Kids");
  await page.getByRole("switch", { name: "Kids profile" }).click();
  await page.getByRole("radio", { name: "G", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Kids" })).toBeVisible();

  await page.goto("/profiles/new");
  await page.getByLabel("Name").fill("Locked");
  await page.getByRole("switch", { name: "Profile PIN" }).click();
  await page.getByRole("textbox", { name: "PIN", exact: true }).click();
  await page.keyboard.type("1234");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Locked" })).toBeVisible();

  const other = await browser.newContext();
  const second = await other.newPage();

  await signIn(second, owner.email, owner.password);
  await expect(second.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await capture(second, "04-01-whos-watching");
  await second.getByRole("button", { name: "Locked" }).click();
  await expect(second.getByRole("heading", { name: "Enter Locked's PIN" })).toBeVisible();

  await second.getByRole("textbox", { name: "Locked's PIN", exact: true }).click();
  await second.keyboard.type("0000");
  await expect(second.getByText("Wrong PIN. 4 tries left.")).toBeVisible();
  await capture(second, "04-03b-wrong-pin");

  await second.getByRole("textbox", { name: "Locked's PIN", exact: true }).click();
  await second.keyboard.type("1234");
  await expect(second).toHaveURL(/\/$/u);
  await other.close();
});

test("a kids profile's search leaves out what it may not see", async () => {
  await page.goto("/profiles");
  await page.getByRole("button", { name: "Kids" }).click();
  await expect(page).toHaveURL(/\/$/u);

  await openMenu(page);
  await page.getByRole("combobox").fill("Totoro");
  await expect(
    page
      .getByRole("group", { name: "Titles" })
      .getByRole("option", { name: /My Neighbor Totoro/u }),
  ).toBeVisible();
  await capture(page, "06-02-kids-results");

  await page.getByRole("combobox").fill("Sicario");
  await expect(page.getByRole("group", { name: "Titles" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/search?q=${encodeURIComponent("Sicario")}`);
  await expect(page.getByRole("heading", { name: "No results for “Sicario”" })).toBeVisible();
  await capture(page, "06-03-no-results");
});

test("signing out, a wrong password, and signing back in", async () => {
  await openMenu(page);
  await page.getByRole("combobox").fill("sign out");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-in$/u);

  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await capture(page, "03-04-sign-in");
  await signIn(page, owner.email, "not-the-password");
  await expect(page.getByText("Wrong email or password")).toBeVisible();
  await capture(page, "03-04b-wrong-password");

  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
  await page.getByRole("button", { name: owner.name }).click();
  await expect(page).toHaveURL(/\/$/u);
});

test("an invite creates an account once; used and expired invites say so", async ({ browser }) => {
  if (stack === null) return;

  const { invite, ownerId } = await createInvite(stack, owner);
  const guest = await browser.newContext();
  const visitor = await guest.newPage();

  await visitor.goto(`/invite/${invite.code}`);
  await expect(visitor.getByRole("heading", { name: "You're invited." })).toBeVisible();
  await expect(
    visitor.getByText(`${owner.name} invited you to ${owner.name}'s movies`),
  ).toBeVisible();
  await capture(visitor, "03-05-accept-invite");
  await visitor.getByLabel("Your name").fill("Sam");
  await visitor.getByLabel("Email").fill(`sam-${run}@movies.test`);
  await visitor.getByLabel("Choose a password").fill("sam-password-1");
  await visitor.getByRole("button", { name: "Accept and create account" }).click();
  await expect(visitor.getByRole("button", { name: "Sam" })).toBeVisible();
  await guest.close();

  const again = await browser.newContext();
  const late = await again.newPage();

  await late.goto(`/invite/${invite.code}`);
  await expect(late.getByRole("heading", { name: "This invite was already used." })).toBeVisible();

  const expired = plantExpiredInvite(stack, ownerId, `pat-${run}@movies.test`);

  await late.goto(`/invite/${expired}`);
  await expect(late.getByRole("heading", { name: "This invite has expired." })).toBeVisible();
  await expect(late.getByText(`Invite for pat-${run}@movies.test`)).toBeVisible();
  await expect(late.getByRole("link", { name: "I already have an account" })).toBeVisible();
  await capture(late, "03-05b-expired-invite");
  await again.close();
});
