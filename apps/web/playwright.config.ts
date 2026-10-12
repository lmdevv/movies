import { defineConfig, devices } from "@playwright/test";

import { stackEnv } from "./e2e/stack/stack-env";

const stack = stackEnv();

/** The worktree's web port when it has a stack, so worktrees running suites at once never share a server. */
const port = Number(process.env["E2E_PORT"] ?? stack?.webPort ?? 3011);

/**
 * Browser tests against the Vite dev server. `kit` checks the UI kit gallery and needs no backend.
 * `stack` runs the core flows against the worktree's dev stack (`scripts/dev-stack.sh up`) and the
 * real media service, which the suite starts itself; it skips without a fresh stack. `admin` then
 * runs the account and admin screens on the same stack as the owner `stack` created; it skips
 * without a stack.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "kit",
      testMatch: /kit\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "stack",
      testMatch: /stack\/.*\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // Signs in as the owner the core flows create, so it runs after them.
      name: "admin",
      testMatch: /admin\/.*\.spec\.ts$/u,
      dependencies: ["stack"],
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
