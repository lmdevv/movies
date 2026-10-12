import { defineConfig, devices } from "@playwright/test";

import { stackEnv } from "./e2e/stack/stack-env";

const port = Number(process.env["E2E_PORT"] ?? "3011");

const stack = stackEnv();

/** Where the stack suite's artwork comes from: the stack's media URL, served by the fake media. */
const mediaPort = stack === null ? null : new URL(stack.mediaUrl).port;

/**
 * Browser tests against the Vite dev server. `kit` checks the UI kit gallery and needs no backend.
 * `stack` runs the core flows against the worktree's dev stack (`scripts/dev-stack.sh up`) and
 * skips without one; a fake media service serves artwork on the stack's media port.
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
    ...(mediaPort === null
      ? []
      : [
          {
            command: `node e2e/stack/fake-media.ts ${mediaPort}`,
            url: `http://127.0.0.1:${mediaPort}/artwork/poster/ready.svg`,
            reuseExistingServer: true,
          },
        ]),
  ],
});
