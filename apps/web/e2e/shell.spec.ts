import { expect, test } from "@playwright/test";

test("the shell navigates with g-sequences and opens the command menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Home", exact: true }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.keyboard.press("g");
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/movies$/);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();

  await input.fill("shows");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/shows$/);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("the command menu filters, nests and goes back with the keyboard", async ({ page }) => {
  await page.goto("/dev/kit");
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");

  const input = page.getByRole("combobox");
  const active = page.locator('[role="option"][aria-selected="true"]');

  await expect(active).toContainText("Severance");
  await page.keyboard.press("ArrowDown");
  await expect(active).toContainText("Dune: Part Two");
  await page.keyboard.press("Control+p");
  await expect(active).toContainText("Severance");

  await input.fill("subt");
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("placeholder", "Language…");
  await expect(page.getByText("Subtitles · Severance")).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("subt");

  await input.fill("the brutalist");
  await expect(page.getByText("No results for “the brutalist”")).toBeVisible();
  await expect(active).toContainText("Search unmatched files");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("rows take focus with j and k and move between cards with arrows", async ({ page }) => {
  await page.goto("/dev/kit");
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();

  const focused = page.locator(":focus");

  await page.keyboard.press("j");
  await expect(focused).toContainText("Dune: Part Two");
  await page.keyboard.press("ArrowRight");
  await expect(focused).toContainText("Severance · S2:E4");
  await page.keyboard.press("j");
  await expect(focused).toContainText("Andor");
  await page.keyboard.press("k");
  await expect(focused).toContainText("Severance · S2:E4");
});
