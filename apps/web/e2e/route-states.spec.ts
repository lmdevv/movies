/**
 * The screens every route falls back to, without a backend: an unknown address, and a screen that
 * crashes while rendering until Try again finds it working.
 */
import { expect, test } from "@playwright/test";

test("an unknown address says so and leads home", async ({ page }) => {
  await page.goto("/nowhere/at-all");

  await expect(page.getByRole("heading", { name: "This page isn't here" })).toBeVisible();
  await expect(page).toHaveTitle("Not found · [movies]");
  await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
});

test("a crashed screen recovers with Try again", async ({ page }) => {
  // The dev-only crash page throws until this time, then renders normally.
  const until = Date.now() + 2_000;

  await page.goto(`/dev/crash?until=${until}`);
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  // Signed out, nobody manages the server, so the error itself stays hidden.
  await expect(page.getByText("Error details")).toBeHidden();

  await page.waitForFunction((time) => Date.now() >= time, until);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "This screen recovered" })).toBeVisible();
});
