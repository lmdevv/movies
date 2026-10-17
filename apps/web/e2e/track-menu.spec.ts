/**
 * The player's track menu on the dev bench (`/dev/tracks`), without a backend: it stays inside the
 * window above its trigger at any size, text size, and in full screen; it opens on the chosen
 * subtitle, well down a list of thirty-two; its headings stay put while each column's options
 * scroll on their own, by wheel, finger, and keyboard; and Escape closes it back to its trigger.
 */
import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const LABEL = "Audio, subtitles, and quality";

const HEADINGS = {
  "1": ["Subtitles"],
  "3": ["Audio", "Subtitles", "Quality"],
  "4": ["Version", "Audio", "Subtitles", "Quality"],
} as const;

/** The bench's first subtitle track. */
const FIRST_SUBTITLE = "Off";

/** The subtitle the bench starts on, well down the list. */
const CHOSEN_SUBTITLE = "Українська";

/** The track after it. */
const NEXT_SUBTITLE = "Русский";

/** The bench's last subtitle track. */
const LAST_SUBTITLE = "简体中文";

const FIRST_AUDIO = "English · Dolby TrueHD 7.1 Atmos";

const open = async (page: Page, columns: keyof typeof HEADINGS): Promise<Locator> => {
  await page.goto(`/dev/tracks?columns=${columns}`);
  await page.getByRole("button", { name: LABEL }).click();

  const menu = page.getByRole("dialog", { name: LABEL });

  await expect(menu).toBeVisible();
  // Measure once it has finished growing in.
  await menu.evaluate(async (popup) => {
    await Promise.all(popup.getAnimations().map(async (animation) => animation.finished));
  });

  return menu;
};

/** The menu lies inside the window and above its trigger, clear of the controls under it. */
const expectContained = async (page: Page, menu: Locator): Promise<void> => {
  const viewport = page.viewportSize();
  const box = await menu.boundingBox();
  const trigger = await page.getByRole("button", { name: LABEL }).boundingBox();

  if (viewport === null || box === null || trigger === null) throw new Error("Nothing to measure");

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(trigger.y);
};

/**
 * Each heading comes whole into view inside the menu and the window, scrolling the columns
 * sideways if they are wider than the window.
 */
const expectHeadings = async (menu: Locator, headings: ReadonlyArray<string>): Promise<void> => {
  const hidden = await menu.evaluate((popup, names) => {
    const bounds = popup.getBoundingClientRect();
    const labels = [...popup.querySelectorAll("span")];

    return names.filter((name) => {
      const heading = labels.find((label) => label.textContent === name);

      if (heading === undefined) return true;

      heading.scrollIntoView({ block: "nearest", inline: "nearest" });

      const box = heading.getBoundingClientRect();

      return (
        box.left < Math.max(0, bounds.left) ||
        box.top < Math.max(0, bounds.top) ||
        box.right > Math.min(window.innerWidth, bounds.right) ||
        box.bottom > Math.min(window.innerHeight, bounds.bottom)
      );
    });
  }, headings);

  expect(hidden).toEqual([]);
};

/** No option's label is cut off: long ones wrap. */
const expectNoClippedLabels = async (menu: Locator): Promise<void> => {
  const clipped = await menu
    .getByRole("radio")
    .evaluateAll((radios) =>
      radios
        .filter((radio) => radio.scrollWidth > radio.clientWidth + 1)
        .map((radio) => radio.textContent),
    );

  expect(clipped).toEqual([]);
};

const subtitle = (menu: Locator, name: string): Locator =>
  menu.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio", { name, exact: true });

/** The focused option shows its focus ring whole, inside the list it scrolls in. */
const expectWholeFocusRing = async (page: Page): Promise<void> => {
  const ring = await page.evaluate(() => {
    const focused = document.activeElement;
    const list = focused?.closest('[role="radiogroup"]');

    if (!(focused instanceof HTMLElement) || !(list instanceof HTMLElement)) return null;

    const style = getComputedStyle(focused);
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    const box = focused.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();

    return {
      visible: focused.matches(":focus-visible") && reach > 0,
      inside: box.top - reach >= bounds.top && box.bottom + reach <= bounds.bottom,
    };
  });

  expect(ring).toEqual({ visible: true, inside: true });
};

const headingBoxes = async (menu: Locator, headings: ReadonlyArray<string>) =>
  Promise.all(
    headings.map(async (heading) => menu.getByText(heading, { exact: true }).boundingBox()),
  );

for (const columns of ["1", "3", "4"] as const) {
  test(`a ${columns} column menu fits a desktop window and opens on the chosen subtitle`, async ({
    page,
  }) => {
    const menu = await open(page, columns);

    await expectContained(page, menu);
    await expectHeadings(menu, HEADINGS[columns]);
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeChecked();
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
    // Thirty-two tracks are longer than the menu: the first wait above.
    await expect(subtitle(menu, FIRST_SUBTITLE)).not.toBeInViewport();
    await expectNoClippedLabels(menu);
  });
}

const WINDOWS = [
  { name: "a short window", viewport: { width: 1280, height: 360 } },
  { name: "a phone held sideways", viewport: devices["iPhone 13 landscape"].viewport },
  { name: "a phone held upright", viewport: devices["iPhone 13"].viewport },
  { name: "a small phone held sideways", viewport: { width: 568, height: 320 } },
] as const;

for (const { name, viewport } of WINDOWS) {
  test(`four columns stay inside ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);

    const menu = await open(page, "4");

    await expectContained(page, menu);
    // The heading scrolls the panel sideways only; the chosen track under it is already in view.
    await expectHeadings(menu, ["Subtitles"]);
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
    await expectHeadings(menu, HEADINGS["4"]);
    await expectContained(page, menu);
    await expectNoClippedLabels(menu);
  });
}

test("rotating a phone with the menu open keeps it inside and on the chosen subtitle", async ({
  page,
}) => {
  await page.setViewportSize(devices["iPhone 13"].viewport);

  const menu = await open(page, "3");

  await expectContained(page, menu);
  await page.setViewportSize(devices["iPhone 13 landscape"].viewport);
  await expect.poll(async () => (await menu.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await expectContained(page, menu);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
});

test("text at double size keeps the menu inside the window and readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/dev/tracks?columns=4");
  // What a browser's text size setting does: double the root size every rem follows, and the
  // menu's text with it.
  await page.addStyleTag({
    content: `:root { font-size: 200%; --text-body: 30px; --leading-label: 36px;
      --text-caption: 24px; --leading-caption: 32px; }`,
  });
  await page.getByRole("button", { name: LABEL }).click();

  const menu = page.getByRole("dialog", { name: LABEL });

  await expect(menu).toBeVisible();
  await expectContained(page, menu);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectHeadings(menu, HEADINGS["4"]);
  await expectNoClippedLabels(menu);
});

test("the wheel scrolls one column, leaving the headings and the other columns still", async ({
  page,
}) => {
  const menu = await open(page, "4");
  const headings = await headingBoxes(menu, HEADINGS["4"]);

  await subtitle(menu, CHOSEN_SUBTITLE).hover();
  await page.mouse.wheel(0, 4000);
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await page.mouse.wheel(0, -8000);
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });

  await expect(menu.getByRole("radio", { name: "Auto", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeInViewport({ ratio: 1 });
  expect(await headingBoxes(menu, HEADINGS["4"])).toEqual(headings);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  await expectContained(page, menu);
});

test("arrow keys bring each subtitle into view; Escape closes back to the trigger", async ({
  page,
}) => {
  const menu = await open(page, "4");

  // Focus starts on the first column's choice; Tab moves column to column.
  await expect(menu.getByRole("radio", { name: /^1080p Theatrical/u })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeFocused();

  // The chosen track shows at the foot of the list; the next one scrolls up into view.
  await expect(subtitle(menu, NEXT_SUBTITLE)).not.toBeInViewport({ ratio: 1 });
  await page.keyboard.press("ArrowDown");
  await expect(subtitle(menu, NEXT_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, NEXT_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);

  // From the first track, up wraps around to the last, and down back to the first.
  await page.mouse.move(0, 0);
  await subtitle(menu, NEXT_SUBTITLE).hover();
  await page.mouse.wheel(0, -8000);
  await subtitle(menu, FIRST_SUBTITLE).click();
  await page.keyboard.press("ArrowUp");
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeChecked();
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);
  await page.keyboard.press("ArrowDown");
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);
  await expect(menu.getByText("Subtitles", { exact: true })).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: LABEL })).toBeFocused();
});

test("a finger drags one column's options, not the page", async ({ browser }) => {
  const phone = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await phone.newPage();

  try {
    const menu = await open(page, "3");
    const headings = await headingBoxes(menu, HEADINGS["3"]);
    const list = await menu.getByRole("radiogroup", { name: "Subtitles" }).boundingBox();

    if (list === null) throw new Error("Nothing to drag");

    // A finger dragging up the list, as Chromium's compositor scrolls it.
    const cdp = await phone.newCDPSession(page);
    const x = list.x + list.width / 2;
    const from = list.y + list.height - 4;
    const to = list.y + 4;

    const touch = async (type: "touchStart" | "touchMove", y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });

    await touch("touchStart", from);
    await touch("touchMove", from - (from - to) / 3);
    await touch("touchMove", from - ((from - to) * 2) / 3);
    await touch("touchMove", to);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect(subtitle(menu, CHOSEN_SUBTITLE)).not.toBeInViewport({ ratio: 1 });
    await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeInViewport({ ratio: 1 });
    expect(await headingBoxes(menu, HEADINGS["3"])).toEqual(headings);
    await expectContained(page, menu);
  } finally {
    await phone.close();
  }
});

test("in full screen the menu renders inside the player and inside the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto("/dev/tracks?columns=4");
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await page.getByRole("button", { name: LABEL }).click();

  const menu = page.getByRole("dialog", { name: LABEL });

  await expect(menu).toBeVisible();
  expect(await menu.evaluate((popup) => document.fullscreenElement?.contains(popup) ?? false)).toBe(
    true,
  );
  await expectContained(page, menu);
  await expectHeadings(menu, HEADINGS["4"]);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: LABEL })).toBeFocused();
});
