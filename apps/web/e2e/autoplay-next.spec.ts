/**
 * The player's next-episode card on the dev bench (`/dev/autoplay`), without a backend: it stays a
 * compact card inside the window on desktops, short windows, and phones either way up, with a long
 * title, without a still, and at double text size; the countdown's digits change without moving
 * or clipping anything; Play next has focus, and each action does what it says.
 */
import { devices, expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";

import { capture } from "./playback/playback-stack";

/** What a browser's text size setting does: double the root size and the text tokens with it. */
const DOUBLE_TEXT = `:root { font-size: 200%; --text-caption: 24px; --leading-caption: 32px;
  --text-label: 26px; --leading-label: 36px; --text-body: 30px; --text-heading: 40px;
  --leading-heading: 52px; }`;

const card = (page: Page): Locator => page.getByRole("region", { name: "Next episode" });

/** A box, rounded to whole pixels, so subpixel layout never reads as movement. */
const box = async (locator: Locator) => {
  const found = await locator.boundingBox();

  if (found === null) throw new Error("Nothing to measure");

  return {
    x: Math.round(found.x),
    y: Math.round(found.y),
    width: Math.round(found.width),
    height: Math.round(found.height),
  };
};

/**
 * The card lies inside the window, each part of it inside the card, and no text in it is cut off
 * sideways: buttons keep their whole labels, and the title and synopsis wrap to two lines at most.
 */
const expectContained = async (page: Page): Promise<void> => {
  const viewport = page.viewportSize();

  if (viewport === null) throw new Error("No window");

  const outer = await box(card(page));

  expect(outer.x).toBeGreaterThanOrEqual(0);
  expect(outer.y).toBeGreaterThanOrEqual(0);
  expect(outer.x + outer.width).toBeLessThanOrEqual(viewport.width);
  expect(outer.y + outer.height).toBeLessThanOrEqual(viewport.height);

  const report = await card(page).evaluate((section) => {
    const bounds = section.getBoundingClientRect();

    const shown = Array.from(section.querySelectorAll("p, h2, button, [data-slot]")).filter(
      (element) => element.checkVisibility(),
    );

    const parts = shown.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const lines = Math.round(rect.height / Number.parseFloat(style.lineHeight));

      return {
        text: element.textContent,
        inside:
          rect.left >= bounds.left - 0.5 &&
          rect.right <= bounds.right + 0.5 &&
          rect.top >= bounds.top - 0.5 &&
          rect.bottom <= bounds.bottom + 0.5,
        clipped: element.scrollWidth > element.clientWidth + 1,
        lines: element.tagName === "H2" || element.tagName === "P" ? lines : 0,
      };
    });

    return parts;
  });

  for (const part of report) {
    expect.soft(part.inside, `${part.text} lies inside the card`).toBe(true);
    expect.soft(part.clipped, `${part.text} is not cut off`).toBe(false);
    expect.soft(part.lines, `${part.text} takes two lines at most`).toBeLessThanOrEqual(2);
  }
};

/** Waits for the card's fonts, as text set in a fallback face wraps differently. */
const fontsLoaded = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
};

/** Opens the bench in a new context made with `options`, and returns its page. */
const openIn = async (
  browser: Browser,
  options: Parameters<Browser["newContext"]>[0],
  query: string,
): Promise<Page> => {
  const context = await browser.newContext(options);
  const page = await context.newPage();

  await page.goto(`/dev/autoplay?${query}`);
  await expect(card(page)).toBeVisible();
  await fontsLoaded(page);

  return page;
};

const STATES = [
  { name: "desktop", options: { viewport: { width: 1440, height: 900 } } },
  { name: "short-window", options: { viewport: { width: 1280, height: 560 } } },
  { name: "narrow-window", options: { viewport: { width: 640, height: 720 } } },
  { name: "phone-portrait", options: { ...devices["iPhone 13"] } },
  { name: "phone-landscape", options: { ...devices["iPhone 13 landscape"] } },
] as const;

/** The episodes the card shows: as it comes, then with a long title and no still or a broken one. */
const EPISODES = [
  { name: "as it comes", query: "" },
  { name: "a long title without a still", query: "title=long&still=none" },
  { name: "a long title whose still fails", query: "title=long&still=broken&seconds=9" },
] as const;

for (const state of STATES) {
  for (const episode of EPISODES) {
    test(`${state.name}, ${episode.name}: the card stays compact and whole`, async ({
      browser,
    }) => {
      const page = await openIn(browser, state.options, episode.query);

      await expectContained(page);

      // Without a still, or until it loads, the tile shows a glyph; a still that loads covers it.
      await expect(card(page).locator('[data-slot="next-episode-still"] svg')).toBeVisible();

      // In a window wider than tall, the card keeps to its corner, leaving the credits in view.
      const viewport = page.viewportSize();

      if (viewport !== null && viewport.width > viewport.height) {
        expect((await box(card(page))).width).toBeLessThanOrEqual(viewport.width * 0.6);
      }

      if (episode.query === "") await capture(page, `07-05-next-episode-${state.name}`);

      await page.context().close();
    });
  }

  test(`${state.name}, text at double size: the card still fits`, async ({ browser }) => {
    const page = await openIn(browser, state.options, "title=long");

    await page.addStyleTag({ content: DOUBLE_TEXT });
    await expectContained(page);
    await capture(page, `07-05-next-episode-double-text-${state.name}`);
    await page.context().close();
  });
}

for (const state of [STATES[0], STATES[3]]) {
  test(`${state.name}: the countdown's digits change without moving the button, its label, or each other`, async ({
    browser,
  }) => {
    const context = await browser.newContext(state.options);

    /** The button, its label, and its digits with the countdown held at `value`, each in its own page. */
    const measure = async (value: number) => {
      const page = await context.newPage();
      const play = page.getByRole("button", { name: "Play next" });
      const seconds = play.locator('[data-slot="countdown-seconds"]');

      await page.goto(`/dev/autoplay?seconds=${String(value)}`);
      await expect(seconds).toHaveText(String(value));
      await fontsLoaded(page);

      const [button, label, digits, whole] = await Promise.all([
        box(play),
        box(play.getByText("Play next", { exact: true })),
        box(seconds),
        seconds.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ]);

      return { button, label, digits, whole };
    };

    const [ten, ...rest] = await Promise.all([10, 9, 5, 1, 0].map(measure));

    if (ten === undefined) throw new Error("Nothing measured");

    for (const other of rest) expect(other).toEqual(ten);

    // The digits sit whole inside the button, clear of its label.
    expect(ten.whole).toBe(true);
    expect(ten.digits.x).toBeGreaterThanOrEqual(ten.label.x + ten.label.width);
    expect(ten.digits.x + ten.digits.width).toBeLessThanOrEqual(ten.button.x + ten.button.width);
    await context.close();
  });
}

test("Play next has focus and plays the next episode; Watch credits closes the card", async ({
  page,
}) => {
  await page.goto("/dev/autoplay?seconds=1");
  await expect(page.getByRole("button", { name: "Play next" })).toBeFocused();

  // Screen readers hear when it starts, once, rather than every tick: the time is its description,
  // and its name stays the same.
  await expect(page.getByRole("button", { name: "Play next" })).toHaveAccessibleName("Play next");
  await expect(page.getByRole("button", { name: "Play next" })).toHaveAccessibleDescription(
    "Starts in 1 second",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Played next");

  await page.goto("/dev/autoplay");
  await expect(page.getByRole("button", { name: "Play next" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Watch credits" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Watching credits");
});

test("a room guest's card counts down without Play next, and Close only closes it", async ({
  page,
}) => {
  await page.goto("/dev/autoplay?role=follow&seconds=7");
  await expect(page.getByRole("button", { name: "Play next" })).toHaveCount(0);
  await expect(page.getByRole("timer")).toHaveAccessibleName("Starts in 7 seconds");
  await capture(page, "07-05-next-episode-guest");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("status")).toHaveText("Closed");
});
