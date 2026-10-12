/**
 * The web app's core flows against the worktree's real stack (`scripts/dev-stack.sh up`): first
 * run, scans (live, failed, retried), browsing, My List, profiles and PINs, kids filtering, sign
 * in and out, and invites. A fake media worker plays the media service's part through its real
 * Convex functions. Needs a fresh stack (no owner yet); skips without one.
 */
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { movieItems, showItems } from "./catalog";
import {
  claimNextScan,
  completeScan,
  connectMediaWorker,
  failScan,
  reportScan,
} from "./media-worker";
import type { MediaWorker } from "./media-worker";
import { plantExpiredInvite } from "./expired-invite";
import { createInvite } from "./owner";
import { freshStack } from "./fresh-stack";

const stack = await freshStack();

test.skip(stack === null, "needs a fresh dev stack: scripts/dev-stack.sh destroy && up");

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);

/**
 * Appended to every title name so searches match this run only. `E2E_TOKEN=` (empty) keeps plain
 * names, for seeding a stack to look at.
 */
const token = process.env["E2E_TOKEN"] ?? run.slice(-4);

/** A fixture title's name as this run's catalog has it. */
const titled = (name: string): string => (token === "" ? name : `${name} ${token}`);

/** The suite runs on a fresh stack, so the owner can have fixed credentials to sign in with after. */
const owner = { name: "Alex", email: "owner@movies.test", password: "correct-horse-1" };

const mod = process.platform === "darwin" ? "Meta" : "Control";

let context: BrowserContext;

let page: Page;

let worker: MediaWorker;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  worker = await connectMediaWorker(stack);
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  if (stack !== null) await context.close();
});

const openMenu = async (target: Page): Promise<void> => {
  // The shortcuts listen once the signed-in shell is on screen.
  await expect(target.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await target.keyboard.press(`${mod}+k`);
  await expect(target.getByRole("combobox")).toBeFocused();
};

/** Saves a screenshot to `$E2E_SCREENSHOTS/<name>.png` when that folder is set, for design review. */
const capture = async (target: Page, name: string): Promise<void> => {
  const folder = process.env["E2E_SCREENSHOTS"];

  if (folder === undefined || folder === "") return;

  await target.waitForTimeout(400);
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

  // Before any library, Home offers to add one.
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

  await folder.fill(`/e2e/${run}/movies`);
  await page.getByRole("button", { name: "Save and start scan" }).click();
  await expect(page).toHaveURL(/\/setup\/scan/u);
  await expect(page.getByRole("heading", { name: "Building your library." })).toBeVisible();

  const items = movieItems(`/e2e/${run}/movies`, token);
  const claimed = await claimNextScan(worker);

  await reportScan(worker, claimed.jobId, 3, items.length, `/e2e/${run}/movies/Arrival.mkv`);
  await expect(page.getByText("30%")).toBeVisible();
  await capture(page, "03-03-first-scan");

  // Meanwhile Home shows the scanning layout and the scan's progress card.
  const home = await context.newPage();

  await home.goto("/");
  await expect(home.getByRole("region", { name: "Library scan" })).toContainText("Scanning Movies");
  await expect(home.getByRole("region", { name: "Library scan" })).toContainText("3 / 10");
  await capture(home, "05-07-scanning");
  await home.close();

  await completeScan(worker, claimed, items);
  await expect(page.getByText("100%")).toBeVisible();
  await expect(page.getByText(String(items.length)).first()).toBeVisible();

  // The owner's profile was chosen on this browser already, so Home opens straight away.
  await page.getByRole("link", { name: "Continue to [movies]" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("region", { name: "Recently added" })).toBeVisible();
});

test("a failed scan says so and can be retried", async () => {
  await page.goto("/setup/library");
  await page.getByRole("radio", { name: "Shows" }).click();
  await page.getByLabel("Folder path", { exact: true }).fill(`/e2e/${run}/shows`);
  await page.getByRole("button", { name: "Save and start scan" }).click();
  await expect(page).toHaveURL(/\/setup\/scan/u);

  const first = await claimNextScan(worker);

  await reportScan(worker, first.jobId, 2, 9, null);
  await failScan(worker, first.jobId, "Can't open Severance/Season 2: permission denied");
  await expect(page.getByRole("heading", { name: "The scan stopped." })).toBeVisible();
  await expect(page.getByText("Can't open Severance/Season 2: permission denied")).toBeVisible();
  await capture(page, "03-03b-scan-failed");

  await page.getByRole("button", { name: "Retry scan" }).click();

  const retry = await claimNextScan(worker);

  await completeScan(worker, retry, showItems(`/e2e/${run}/shows`, token));
  await expect(page.getByRole("heading", { name: "Building your library." })).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible();
});

test("home shows the library; a title opens, joins My List, and the keyboard navigates", async () => {
  await page.goto("/");

  const recent = page.getByRole("region", { name: "Recently added" });

  await expect(recent.getByRole("link", { name: titled("Arrival") })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shows" })).toBeVisible();

  await recent.getByRole("link", { name: titled("Arrival") }).click();
  await expect(page.getByRole("heading", { name: titled("Arrival").toUpperCase() })).toBeVisible();
  await expect(page.getByText("PG-13", { exact: true })).toBeVisible();
  await expect(page.getByText("HEVC", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add to My List" }).click();
  await expect(page.getByRole("button", { name: "Remove from My List" })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(/\/my-list$/u);
  await expect(page.getByRole("link", { name: new RegExp(titled("Arrival"), "u") })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/shows$/u);
  await page.getByRole("link", { name: new RegExp(titled("Severance"), "u") }).click();
  await expect(page.getByRole("region", { name: "Episodes" })).toBeVisible();
  await expect(page.getByText("Good News About Hell", { exact: true })).toBeVisible();

  await openMenu(page);
  await page.getByRole("combobox").fill("movies");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/movies$/u);
  await expect(page.getByRole("link", { name: new RegExp(titled("Sicario"), "u") })).toBeVisible();
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

  // A new browser session must enter the PIN.
  const other = await browser.newContext();
  const second = await other.newPage();

  await signIn(second, owner.email, owner.password);
  await expect(second.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
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
  await page.getByRole("combobox").fill(titled("Totoro"));
  await expect(
    page
      .getByRole("group", { name: "Titles" })
      .getByRole("option", { name: new RegExp(titled("My Neighbor Totoro"), "u") }),
  ).toBeVisible();
  await capture(page, "06-02-kids-results");

  await page.getByRole("combobox").fill(titled("Sicario"));
  await expect(page.getByRole("option", { name: "Searching…" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Titles" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/search?q=${encodeURIComponent(titled("Sicario"))}`);
  await expect(
    page.getByRole("heading", { name: `No results for “${titled("Sicario")}”` }),
  ).toBeVisible();
  await capture(page, "06-03-no-results");
});

test("signing out, a wrong password, and signing back in", async () => {
  await openMenu(page);
  await page.getByRole("combobox").fill("sign out");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-in$/u);

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
