import { expect, test } from "@playwright/test";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test("a device's code is approved in the browser, the device signs in, and the code works once", async ({
  page,
}) => {
  if (stack === null) return;

  const owner = await signInOwner(stack);
  const device = openClient(stack);
  const login = await device.sdk.auth.startDeviceLogin("Living room TV");
  const signedIn = login.complete();

  expect(new URL(login.verificationUrl).searchParams.get("code")).toBe(login.userCode);

  await useSession(page, owner);
  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "Enter the code on your device" })).toBeVisible();
  await page.getByRole("textbox").first().click();
  await page.keyboard.type(login.userCode.replace("-", "").toLowerCase());
  await expect(page).toHaveURL(new RegExp(`code=${login.userCode}`, "u"));

  await expect(
    page.getByRole("heading", { name: /Living room TV\s*wants to sign in as/u }),
  ).toBeVisible();
  await expect(page.getByRole("definition").getByText(login.userCode)).toBeVisible();
  await expect(page.getByRole("button", { name: "read" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "play" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "admin" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: /Living room TV\s*is signed in/u })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage devices" })).toBeVisible();

  await signedIn;
  await expect(device.sdk.query("account.viewer", {})).resolves.toMatchObject({
    sessionKind: "device",
    scopes: ["read", "play"],
  });

  await page.getByRole("link", { name: "Manage devices" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Living room TV" }).first()).toContainText(
    "Device",
  );

  await page.goto(`/device?code=${login.userCode}`);
  await expect(page.getByRole("heading", { name: "That code was already used" })).toBeVisible();
  await expect(page.getByText(`${login.userCode} is used up`)).toBeVisible();
});

test("a device can be denied", async ({ page }) => {
  if (stack === null) return;

  const owner = await signInOwner(stack);
  const device = openClient(stack);
  const login = await device.sdk.auth.startDeviceLogin("Unknown laptop");

  const refused = login.complete().then(
    () => "signed in",
    (cause: unknown) => (cause instanceof Error ? cause.message : "refused"),
  );

  await useSession(page, owner);
  await page.goto("/settings/devices");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.getByRole("combobox").fill(login.userCode.toLowerCase());
  await page.getByRole("option", { name: `Approve device code ${login.userCode}` }).click();
  await expect(page).toHaveURL(new RegExp(`/device\\?code=${login.userCode}`, "u"));
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("heading", { name: "Unknown laptop was denied" })).toBeVisible();
  await expect(refused).resolves.toBe("Device sign-in denied: start a new sign-in");
});

test("an unknown code says so and lets the person type another", async ({ page }) => {
  if (stack === null) return;

  await useSession(page, await signInOwner(stack));
  await page.goto("/device?code=ZZZZ-ZZZZ");
  await expect(page.getByRole("heading", { name: "That code isn’t valid" })).toBeVisible();
  await expect(page.getByText("No device is waiting for ZZZZ-ZZZZ")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("textbox").first()).toHaveValue("");
  await expect(page.getByRole("textbox").first()).toBeFocused();
});

test("signed-out visitors sign in first and come back to the code", async ({ page }) => {
  await page.goto("/device?code=HDRB-GTLK");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fdevice%3Fcode%3DHDRB-GTLK$/u);
});
