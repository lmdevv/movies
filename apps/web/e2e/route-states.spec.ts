import { expect, test } from "@playwright/test";

test("an unknown address says so and leads home", async ({ page }) => {
  await page.goto("/nowhere/at-all");

  await expect(page.getByRole("heading", { name: "This page isn't here" })).toBeVisible();
  await expect(page).toHaveTitle("Not found · [movies]");
  await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
});

test("a crashed screen recovers with Try again", async ({ page }) => {
  const now = Date.now();
  const until = now + 60_000;

  await page.clock.setFixedTime(now);
  await page.goto(`/dev/crash?until=${until}`);
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(page.getByText("Error details")).toBeHidden();

  await page.clock.setFixedTime(until);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "This screen recovered" })).toBeVisible();
});
