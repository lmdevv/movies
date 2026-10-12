import { expect, test } from "@playwright/test";

import { openBackupWorker } from "./backup-worker";
import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test("an admin backs up now from the command menu and asks before restoring", async ({ page }) => {
  if (stack === null) return;

  const owner = await signInOwner(stack);
  const runBackup = await openBackupWorker(stack);
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await useSession(page, owner);
  await page.goto("/admin/backups");
  await expect(page.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();

  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox").fill("back up now");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Backing up…" })).toBeDisabled();

  const [job] = await owner.sdk.query("jobs.list", { kind: "backup", status: "pending", limit: 1 });

  if (job === undefined) throw new Error("Back up now queued nothing");

  const fileName = `movies-e2e-${Date.now().toString(36)}-manual.zip`;

  await runBackup(job.id, fileName, 182_000_000);

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
