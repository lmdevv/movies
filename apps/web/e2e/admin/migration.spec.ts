/**
 * Migration from Jellyfin against the real media service: Connect says why a source could not be
 * used under the field it concerns, and a full import goes through Review (one source user mapped
 * to a profile, the other skipped), Importing, and Done. The source is the recorded Jellyfin
 * server over the generated fixture library, or a real Jellyfin in Docker with
 * `MOVIES_JELLYFIN_DOCKER=1` (see `jellyfin-source.ts`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProfileId } from "@movies/contracts/ids";
import { expect, test } from "@playwright/test";

import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { startJellyfinSource } from "./jellyfin-source";
import type { JellyfinSource } from "./jellyfin-source";
import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";
import type { Client } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Generating the library, starting the source, and bundling the service take a while. */
const SETUP_TIMEOUT_MS = 300_000;

/** The import waits for the new libraries' first scans, then writes the watch state. */
const IMPORT_TIMEOUT_MS = 180_000;

const run = Date.now().toString(36);

/** The profile Jellyfin's `admin` imports into. */
const PROFILE = `Jellyfin ${run}`;

/** The approved library root, holding the fixture library Jellyfin serves. */
let workspace = "";

let source: JellyfinSource | undefined;

let media: MediaService | undefined;

let owner: Client | undefined;

let profileId: ProfileId | undefined;

test.beforeAll(async () => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-migration-"));
  source = await startJellyfinSource(workspace);
  buildMediaService();
  media = await startMediaService(stack, [workspace]);
  owner = await signInOwner(stack);
  profileId = (
    await owner.sdk.mutate("profiles.create", { name: PROFILE, avatar: "red", kids: false })
  ).id;
});

test.afterAll(async () => {
  if (owner !== undefined) {
    const sdk = owner.sdk;
    const libraries = await sdk.query("libraries.listDetails", {}).catch(() => []);

    await Promise.all(
      libraries
        .filter((library) => library.roots.some((root) => root.startsWith(workspace)))
        .map((library) => sdk.mutate("libraries.remove", { libraryId: library.id })),
    ).catch(() => undefined);

    if (profileId !== undefined) {
      await sdk.mutate("profiles.remove", { profileId }).catch(() => undefined);
    }

    await sdk.dispose();
  }

  await media?.stop();
  await source?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test("Couldn't connect shows why under the address or the key", async ({ page }) => {
  if (owner === undefined || source === undefined) throw new Error("Setup did not finish");

  await useSession(page, owner);
  await page.goto("/admin/users");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Migration" })
    .click();
  await expect(page.getByRole("heading", { name: "Import from Jellyfin or Plex" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Jellyfin" })).toBeChecked();
  await expect(page.getByText("Emby")).toHaveCount(0);

  // Nothing listens on port 1.
  await page.getByLabel("Server URL").fill("http://127.0.0.1:1");
  await page.getByLabel("API key").fill("anything");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Nothing answered at this address.")).toBeVisible();
  await expect(page.getByLabel("Server URL")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Server URL").fill(source.url);
  await page.getByLabel("API key").fill("not-the-key");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Jellyfin didn’t accept this API key.")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Nothing answered at this address.")).toHaveCount(0);

  await page.getByRole("radio", { name: "Plex" }).click();
  await expect(page.getByLabel("Plex token")).toBeVisible();
});

test("an admin connects, reviews, imports, and lands on Done", async ({ page }) => {
  if (owner === undefined || source === undefined) throw new Error("Setup did not finish");

  test.setTimeout(IMPORT_TIMEOUT_MS + 60_000);

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await useSession(page, owner);
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox").fill("jellyfin");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/migration$/u);

  await page.getByLabel("Server URL").fill(source.url);
  await page.getByLabel("API key").fill(source.apiKey);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Ready to import" })).toBeVisible();

  // No [movies] account matches Jellyfin's users, so neither is imported until one is mapped.
  const admin = page.getByLabel("admin", { exact: true });
  const bob = page.getByLabel("bob", { exact: true });
  await expect(admin).toHaveValue("skip");
  await expect(bob).toHaveValue("skip");
  await expect(page.getByText("admin, bob won’t be imported")).toBeVisible();

  await admin.selectOption({ label: PROFILE });
  await expect(page.getByText("user · admin", { exact: true })).toBeVisible();
  await expect(page.getByText("bob won’t be imported")).toBeVisible();

  const libraries = page.getByRole("region", { name: "Libraries · used in place" });
  await expect(libraries).toContainText(join(workspace, "movies"));
  await expect(libraries).toContainText(join(workspace, "shows"));
  await expect(libraries).toContainText("Movies · new");

  await page.getByRole("button", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/admin\/migration\?job=/u);
  await expect(page.getByRole("heading", { name: "Importing from Jellyfin" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Import from Jellyfin" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Imported from Jellyfin" })).toBeVisible({
    timeout: IMPORT_TIMEOUT_MS,
  });
  await expect(page.getByText("libraries added")).toBeVisible();

  // What Done counted is in [movies]: admin's watched movie, its progress, and its favorite show.
  if (profileId === undefined) throw new Error("No profile");

  const myList = await owner.sdk.query("myList.list", { profileId });
  expect(myList.map((title) => title.name)).toEqual(["Fixture Show"]);

  const resume = await owner.sdk.query("history.continueWatching", { profileId });
  expect(resume.map((row) => row.title.name)).toContain("Remux Fixture");

  // Reloading keeps Done, as the import is pinned to the URL.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Imported from Jellyfin" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/$/u);
});
