import { expect, test } from "@playwright/test";

import { NO_STACK, openClient, signInOwner, stack, useSession } from "./stack";

test.skip(stack === undefined, NO_STACK);

test("an API key is shown once, signs in, appears in the list, and stops working when revoked", async ({
  page,
  context,
}) => {
  if (stack === undefined) return;

  const owner = await signInOwner(stack);
  const name = `e2e key ${Date.now().toString(36)}`;

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useSession(page, owner);
  await page.goto("/settings/api-keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await page.getByRole("button", { name: "Create key" }).click();
  const create = page.getByRole("dialog", { name: "Create API key" });
  await create.getByLabel("Name").fill(name);
  await create.getByRole("button", { name: "Create key" }).click();

  const created = page.getByRole("dialog", { name: "Copy your new key" });
  await expect(created.getByText("You won’t see this key again. Copy it now.")).toBeVisible();
  const secret = (await created.getByLabel("New API key").textContent()) ?? "";
  expect(secret).toMatch(/^mk_/u);

  await created.getByRole("button", { name: "Copy" }).click();
  await expect(created.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toBeHidden();

  // The secret is gone from the page once the dialog closes.
  await expect(page.getByText(secret)).toHaveCount(0);

  const row = page.getByRole("row").filter({ hasText: name });
  // The list shows the key's prefix: `mk_` and eight random characters.
  await expect(row).toContainText(`${secret.slice(0, 11)}…`);
  await expect(row).toContainText("read");
  await expect(row).toContainText("Never");

  const agent = openClient(stack);
  await agent.sdk.auth.signInWithApiKey(secret);
  await expect(agent.sdk.query("account.viewer", {})).resolves.toMatchObject({
    sessionKind: "apikey",
  });
  await expect(row).not.toContainText("Never");

  await row.getByRole("button", { name: `Revoke ${name}` }).click();
  const revoke = page.getByRole("dialog", { name: `Revoke “${name}”?` });
  await expect(revoke).toContainText("Anything using this key stops working right away.");
  await revoke.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);

  await expect
    .poll(() =>
      agent.sdk.query("account.viewer", {}).then(
        () => "signed in",
        (cause: unknown) => (cause instanceof Error ? cause.message : "failed"),
      ),
    )
    .toBe("This session has ended; sign in again");
});
