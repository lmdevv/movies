/**
 * Library administration against the real media service: a new library waits for the service,
 * scans, lists its files, notices a deleted file, offers fixes for unmatched titles (search stays
 * unavailable without a TMDB key, hand edits work), and says so when its folder goes offline.
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { drawPoster, encodeClip } from "../stack/fixture-library";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import type { StackEnv } from "../stack/stack-env";
import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

/** Generating the clips and bundling the service take a while on a cold machine. */
const SETUP_TIMEOUT_MS = 180_000;

/** How long a scan of the three clips may take, startup included. */
const SCAN_TIMEOUT_MS = 30_000;

const run = Date.now().toString(36);

/** The approved library root, holding the library folder. */
let workspace = "";

let media: MediaService | undefined;

/** The stack's media service without a metadata provider, so search reports itself unavailable. */
const withoutProvider = (env: StackEnv): StackEnv => ({
  ...env,
  mediaEnv: Object.fromEntries(
    Object.entries(env.mediaEnv).filter(([name]) => name !== "TMDB_API_KEY"),
  ),
});

const ARRIVAL_NFO = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Arrival</title>
  <year>2016</year>
  <uniqueid type="tmdb" default="true">329865</uniqueid>
</movie>
`;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-admin-"));

  const films = join(workspace, "Films");
  const arrival = join(films, "Arrival (2016)");

  await mkdir(arrival, { recursive: true });
  // Arrival matches through its NFO and has a poster; the loose files stay unmatched.
  await Promise.all([
    encodeClip(join(arrival, "Arrival.2016.1080p.mkv")),
    writeFile(join(arrival, "movie.nfo"), ARRIVAL_NFO),
    drawPoster(browser, "Arrival", join(arrival, "poster.jpg")),
    encodeClip(join(films, "Stalker.1979.Criterion.mkv")),
    encodeClip(join(films, "The.Prestige.2006.mkv")),
  ]);
  buildMediaService();
});

test.afterAll(async () => {
  await media?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test("an admin adds a library, watches it scan, reviews missing and unmatched files, and sees the folder go offline", async ({
  page,
}) => {
  if (stack === null) return;

  test.setTimeout(120_000);

  const owner = await signInOwner(stack);
  const name = `Films ${run}`;
  const root = join(workspace, "Films");

  await useSession(page, owner);
  await page.goto("/admin/libraries");
  await expect(page.getByRole("heading", { name: "Libraries" })).toBeVisible();

  await page.getByRole("button", { name: "Add library" }).click();
  const add = page.getByRole("dialog", { name: "Add library" });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Folder 1").fill(root);
  await add.getByRole("button", { name: "Add library" }).click();
  await expect(add).toBeHidden();

  // No media service runs yet, so the scan waits for one.
  const row = page.getByRole("rowgroup").filter({ hasText: name });
  await expect(row).toContainText(root);
  await expect(row).toContainText("Queued");

  media = await startMediaService(withoutProvider(stack), [workspace]);
  await expect(row).toContainText("Ready", { timeout: SCAN_TIMEOUT_MS });
  await expect(row).toContainText("3 titles");

  await row.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  const files = page.getByRole("table", { name: "Files" });
  // Rows count the header too.
  await expect(files.getByRole("row")).toHaveCount(4);
  await expect(files).toContainText("Arrival.2016.1080p.mkv");
  await expect(files).toContainText("1080p · H.264");
  await expect(files).toContainText("Arrival (2016)");

  // A file disappears from disk; the next scan marks it missing.
  await rm(join(root, "The.Prestige.2006.mkv"));
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("note")).toContainText("1 file disappeared", {
    timeout: SCAN_TIMEOUT_MS,
  });

  await page.getByRole("button", { name: "Review 1 missing" }).click();
  await expect(page.getByRole("radio", { name: /Missing/u })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(files.getByRole("row")).toHaveCount(2);
  await expect(files).toContainText("The.Prestige.2006.mkv");
  await expect(files).toContainText("Missing");

  // Both loose files are unmatched, the missing one included.
  await page.getByRole("radio", { name: /Unmatched/u }).click();
  await expect(files.getByRole("row")).toHaveCount(3);
  await page.getByLabel("Filter by title or filename").fill("stalker");
  await expect(files.getByRole("row")).toHaveCount(2);

  // Without a metadata provider search is unavailable; a hand edit still renames the title.
  await files.getByRole("link", { name: "Fix match" }).click();
  await expect(page.getByRole("heading", { name: "Fix match" })).toBeVisible();
  await expect(page.getByText(join(root, "Stalker.1979.Criterion.mkv"))).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "TMDB search isn’t available on this server",
  );
  await page.getByLabel("Title", { exact: true }).fill("Stalker (Criterion)");
  await page.getByRole("button", { name: "Apply match" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("radio", { name: /All/u }).click();
  await expect(files).toContainText("best guess · Stalker (Criterion) (1979)");

  // A matched title shows its poster from the media service.
  await files
    .getByRole("row")
    .filter({ hasText: "Arrival.2016.1080p.mkv" })
    .getByRole("link", { name: "Fix match" })
    .click();
  const poster = page.getByRole("img", { name: "Arrival" });
  await expect(poster).toHaveAttribute("src", /\/artwork\//u);
  await expect
    .poll(() => poster.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByRole("link", { name: "Cancel" }).click();

  // The share drops: the next scan cannot read the folder.
  await rename(root, `${root}-offline`);
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeVisible({
    timeout: SCAN_TIMEOUT_MS,
  });
  await expect(page.getByText(/Offline since/u)).toBeVisible();
  await page.getByRole("button", { name: "View log" }).click();
  await expect(page.getByRole("dialog", { name: "Last scan" })).toContainText(
    "Library root unavailable",
  );
  await page.keyboard.press("Escape");

  // It comes back, and a retry scans it again.
  await rename(`${root}-offline`, root);
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeHidden({
    timeout: SCAN_TIMEOUT_MS,
  });
  await expect(files).toContainText("Arrival.2016.1080p.mkv");
});
