import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

import { stackEnv } from "./e2e/stack/stack-env";

const stack = stackEnv();

/** The worktree's web port when it has a stack, so worktrees running suites at once never share a server. */
const port = Number(process.env["E2E_PORT"] ?? stack?.webPort ?? 3011);

/**
 * A Chromium to run instead of Playwright's download, for hosts that cannot run that build (NixOS
 * without nix-ld). It must decode H.264 and AAC, as the playback suites expect.
 */
const chromium = process.env["E2E_CHROMIUM"];

const launchOptions: LaunchOptions = {};

if (chromium !== undefined && chromium !== "") launchOptions.executablePath = chromium;

/**
 * Browser tests against the Vite dev server. `kit` checks the UI kit gallery and the not-found and
 * error screens, and needs no backend.
 * `stack` runs the core flows against the worktree's dev stack (`scripts/dev-stack.sh up`) and the
 * real media service, which the suite starts itself; it skips without a fresh stack. `admin` then
 * runs the account and admin screens on the same stack as the owner `stack` created; it skips
 * without a stack. `metadata` scans an NFO library for the title, person, genre, and collection
 * pages. `player` and then `rooms` play generated clips through the real media service as that
 * owner, `scrubbing` checks scrub thumbnails and chapters, `casting` casts to a scripted
 * Chromecast, `versions` chooses among a title's files, `migration` imports from a Jellyfin through it, and `backups` runs a real backup job
 * on it last. The suites that run a media service take turns, as it owns the stack's port.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: [
    {
      name: "kit",
      testMatch: /e2e\/(kit|route-states)\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "stack",
      testMatch: /e2e\/stack\/.*\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // Signs in as the owner the core flows create, so it runs after them.
      name: "admin",
      testMatch: /e2e\/admin\/.*\.spec\.ts$/u,
      testIgnore: /e2e\/admin\/(migration|backups)\.spec\.ts$/u,
      dependencies: ["stack"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // Scans its own NFO library with its own media service as the owner, after the admin suites.
      name: "metadata",
      testMatch: /e2e\/metadata\/.*\.spec\.ts$/u,
      dependencies: ["admin"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "player",
      testMatch: /e2e\/playback\/player\.spec\.ts$/u,
      dependencies: ["metadata"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "rooms",
      testMatch: /e2e\/playback\/rooms\.spec\.ts$/u,
      dependencies: ["player"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "scrubbing",
      testMatch: /e2e\/playback\/scrubbing\.spec\.ts$/u,
      dependencies: ["rooms"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "casting",
      testMatch: /e2e\/playback\/casting\.spec\.ts$/u,
      dependencies: ["scrubbing"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "versions",
      testMatch: /e2e\/playback\/versions\.spec\.ts$/u,
      dependencies: ["casting"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "migration",
      testMatch: /e2e\/admin\/migration\.spec\.ts$/u,
      dependencies: ["versions"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "backups",
      testMatch: /e2e\/admin\/backups\.spec\.ts$/u,
      dependencies: ["migration"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      env: {
        VITE_CONVEX_URL: stack?.convexUrl ?? "http://127.0.0.1:3210",
        VITE_MEDIA_BASE_URL: stack?.mediaUrl ?? "",
      },
    },
  ],
});
