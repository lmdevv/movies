import { expect, test } from "@playwright/test";

import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";
import type { Client } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

let owner: Client | undefined;

let otherTableId = "";

test.beforeAll(async () => {
  if (stack === null) return;

  owner = await signInOwner(stack);

  const profiles = await owner.sdk.query("profiles.list", {});

  otherTableId = profiles[0]?.id ?? "";
});

test.afterAll(async () => {
  await owner?.sdk.dispose();
});

test.beforeEach(async ({ page }) => {
  if (owner === undefined) throw new Error("The owner did not sign in");

  await useSession(page, owner);
});

test("an unknown address inside the app keeps the shell", async ({ page }) => {
  await page.goto("/settings/nowhere");

  await expect(page.getByRole("heading", { name: "This page isn't here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "[movies] home" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /switch profile/u })).toBeVisible();

  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/$/u);
});

test("a mistyped title link says the title isn't here", async ({ page }) => {
  await page.goto("/title/not-a-title");

  await expect(page.getByRole("heading", { name: "This title isn't here" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
});

test("a title link with another table's ID says the title isn't here", async ({ page }) => {
  await page.goto(`/title/${otherTableId}`);

  await expect(page.getByRole("heading", { name: "This title isn't here" })).toBeVisible();
});

test("a library link with a bad ID says the library is gone", async ({ page }) => {
  await page.goto(`/admin/libraries/${otherTableId}`);

  await expect(page.getByRole("heading", { name: "This library is gone" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Libraries" })).toBeVisible();
});

test("a crashed screen shows the owner the error", async ({ page }) => {
  await page.goto("/dev/crash");

  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await page.getByText("Error details").click();
  await expect(page.getByText("This screen crashed on purpose")).toBeVisible();
});
