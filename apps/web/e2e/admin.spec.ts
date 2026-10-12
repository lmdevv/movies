import { expect, test } from "@playwright/test";

import { movieFile, openMediaWorker } from "./media-worker";
import { NO_STACK, signInOwner, stack, useSession } from "./stack";

test.skip(stack === undefined, NO_STACK);

test("an admin adds a library, watches its scan, reviews missing and unmatched files, and sees the NAS go offline", async ({
  page,
}) => {
  if (stack === undefined) return;

  const owner = await signInOwner(stack);
  const scanner = await openMediaWorker(stack);
  const id = Date.now().toString(36);
  const name = `Films ${id}`;
  const root = `/e2e-${id}/movies`;

  await useSession(page, owner);
  await page.goto("/admin/libraries");
  await expect(page.getByRole("heading", { name: "Libraries" })).toBeVisible();

  await page.getByRole("button", { name: "Add library" }).click();
  const add = page.getByRole("dialog", { name: "Add library" });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Folder 1").fill(root);
  await add.getByRole("button", { name: "Add library" }).click();
  await expect(add).toBeHidden();

  const row = page.getByRole("rowgroup").filter({ hasText: name });
  await expect(row).toContainText(root);
  await expect(row).toContainText("Queued");

  const jobs = await owner.sdk.query("jobs.list", { kind: "scan", limit: 20 });
  const libraries = await owner.sdk.query("libraries.listDetails", {});
  const library = libraries.find((each) => each.name === name);

  const job = jobs.find(
    (each) => each.payload.kind === "scan" && each.payload.libraryId === library?.id,
  );

  if (library === undefined || job === undefined) throw new Error("The new library has no scan");

  await scanner.claim(job.id);
  await scanner.progress(job.id, 2, 4, "Arrival.2016.2160p.mkv · 2 new");
  await expect(row).toContainText("Scanning");
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await expect(row).toContainText("2 / 4 files · 50%");
  await expect(row).toContainText("Arrival.2016.2160p.mkv · 2 new");

  await scanner.upsert(library.id, [
    movieFile(`${root}/Arrival.2016.2160p.mkv`, "Arrival", 2016),
    movieFile(`${root}/Stalker.1979.Criterion.mkv`, "Stalker", 1979),
    movieFile(`${root}/The.Prestige.2006.mkv`, "The Prestige", 2006),
  ]);
  await scanner.markMissing(library.id, [`${root}/The.Prestige.2006.mkv`]);
  await scanner.complete(job.id);
  await expect(row).toContainText("Ready");
  await expect(row).toContainText("3 titles");

  await row.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("1 file disappeared");

  const files = page.getByRole("table", { name: "Files" });
  await expect(files.getByRole("row")).toHaveCount(4);
  await expect(files).toContainText("Arrival.2016.2160p.mkv");
  await expect(files).toContainText("2160p · HEVC HDR10");

  await page.getByRole("button", { name: "Review 1 missing" }).click();
  await expect(page.getByRole("radio", { name: /Missing/u })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(files.getByRole("row")).toHaveCount(2);
  await expect(files).toContainText("The.Prestige.2006.mkv");
  await expect(files).toContainText("Missing");

  // Every seeded title is unmatched, the missing one included; rows count the header too.
  await page.getByRole("radio", { name: /Unmatched/u }).click();
  await expect(files.getByRole("row")).toHaveCount(4);
  await page.getByLabel("Filter by title or filename").fill("stalker");
  await expect(files.getByRole("row")).toHaveCount(2);

  // Fix the match by hand: the title is renamed and the file list follows.
  await files.getByRole("link", { name: "Fix match" }).click();
  await expect(page.getByRole("heading", { name: "Fix match" })).toBeVisible();
  await expect(page.getByText(`${root}/Stalker.1979.Criterion.mkv`)).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill("Stalker (Criterion)");
  await page.getByRole("button", { name: "Apply match" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("radio", { name: /All/u }).click();
  await expect(page.getByRole("table", { name: "Files" })).toContainText(
    "best guess · Stalker (Criterion) (1979)",
  );

  // The share drops: the next scan cannot read the folder.
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("button", { name: "Scanning…" })).toBeDisabled();

  const rescans = await owner.sdk.query("jobs.list", {
    kind: "scan",
    status: "pending",
    limit: 20,
  });

  const rescan = rescans.find(
    (each) => each.payload.kind === "scan" && each.payload.libraryId === library.id,
  );

  if (rescan === undefined) throw new Error("Scan now queued nothing");

  await scanner.claim(rescan.id);
  await scanner.fail(
    rescan.id,
    `Library root unavailable: ${root} (missing); known files were left untouched`,
  );
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeVisible();
  await expect(page.getByText(/Offline since/u)).toBeVisible();
  await page.getByRole("button", { name: "View log" }).click();
  await expect(page.getByRole("dialog", { name: "Last scan" })).toContainText(
    "Library root unavailable",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeHidden();
});

test("an admin creates and revokes an invite link and sees every account", async ({ page }) => {
  if (stack === undefined) return;

  const owner = await signInOwner(stack);

  await useSession(page, owner);
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Users" })).toContainText("(you)");

  await page.getByLabel("Role").selectOption("admin");
  await page.getByLabel("Link expires").selectOption("14");
  await page.getByRole("button", { name: "Create invite link" }).click();

  const link = page.getByLabel("Invite link");
  await expect(link).toContainText("/invite/");
  const url = (await link.textContent()) ?? "";
  const code = url.slice(url.lastIndexOf("/") + 1);
  await expect(owner.sdk.query("invites.lookup", { code })).resolves.toMatchObject({
    state: "open",
  });

  const pending = page.getByRole("region", { name: "Pending invites" });
  const invite = pending.getByText(/Admin · link · sent .* · expires in 14 days/u).first();
  await expect(invite).toBeVisible();

  const before = await pending.getByRole("button", { name: "Revoke" }).count();
  await pending.getByRole("button", { name: "Revoke" }).first().click();
  await expect(pending.getByRole("button", { name: "Revoke" })).toHaveCount(before - 1);
});

test("an admin backs up now and asks before restoring", async ({ page }) => {
  if (stack === undefined) return;

  const owner = await signInOwner(stack);
  const worker = await openMediaWorker(stack);

  await useSession(page, owner);
  await page.goto("/admin/backups");
  await expect(page.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByRole("button", { name: "Backing up…" })).toBeDisabled();

  const [job] = await owner.sdk.query("jobs.list", { kind: "backup", status: "pending", limit: 1 });

  if (job === undefined) throw new Error("Back up now queued nothing");

  const fileName = `movies-e2e-${Date.now().toString(36)}-manual.zip`;

  await worker.claim(job.id);
  await worker.recordBackup(job.id, fileName, 182_000_000);
  await worker.complete(job.id);

  const row = page.getByRole("row").filter({ hasText: fileName });
  await expect(row).toContainText("Manual");
  await expect(row).toContainText("182 MB");
  await expect(row).toContainText("today");
  await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();

  await row.getByRole("button", { name: /Restore/u }).click();
  await expect(row).toContainText("Selected");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(
    "Everything since then is replaced, and everyone is signed out while the server restarts.",
  );
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(row).not.toContainText("Selected");
});
