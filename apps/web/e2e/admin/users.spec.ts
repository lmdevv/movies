import { expect, test } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test("an admin creates and revokes an invite link and sees every account", async ({ page }) => {
  if (stack === null) return;

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
