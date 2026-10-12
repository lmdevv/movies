import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["E2E_PORT"] ?? "3011");

/**
 * Browser tests against the Vite dev server. The UI kit gallery needs no backend, so a placeholder
 * Convex URL is used unless one is set.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    env: { VITE_CONVEX_URL: process.env["VITE_CONVEX_URL"] ?? "http://127.0.0.1:3210" },
  },
});
