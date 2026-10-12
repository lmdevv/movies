import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each package's tsconfig `paths` (the web app's `@/`) resolve in its tests as they do in its build.
  resolve: { tsconfigPaths: true },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.{ts,tsx}", "packages/backend/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
