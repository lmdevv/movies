/**
 * Finds the local dev stack for the real-stack suites. `scripts/dev-stack.sh up` writes the Convex
 * URL to `packages/backend/.env.local` and the media service's key to `apps/media/.env.local`;
 * environment variables of the same names override them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

const readEnvFile = (path: string): ReadonlyMap<string, string> => {
  if (!existsSync(path)) return new Map();

  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");

        return separator > 0
          ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
          : [];
      }),
  );
};

/** What the real-stack suites need. */
export interface Stack {
  readonly convexUrl: string;
  readonly mediaServiceKey: string;
}

/**
 * The stack to test, or undefined unless `MOVIES_STACK_TESTS=1`, so `pnpm test` stays green
 * without Docker.
 *
 * @throws When `MOVIES_STACK_TESTS=1` but no stack is configured, a setup mistake.
 */
export const findStack = (): Stack | undefined => {
  if (process.env["MOVIES_STACK_TESTS"] !== "1") return undefined;

  const backend = readEnvFile(join(repoRoot, "packages/backend/.env.local"));
  const media = readEnvFile(join(repoRoot, "apps/media/.env.local"));
  const convexUrl = process.env["CONVEX_SELF_HOSTED_URL"] ?? backend.get("CONVEX_SELF_HOSTED_URL");

  const mediaServiceKey =
    process.env["MEDIA_SERVICE_API_KEY"] ?? media.get("MEDIA_SERVICE_API_KEY");

  if (convexUrl === undefined || mediaServiceKey === undefined) {
    throw new Error("MOVIES_STACK_TESTS=1 but no stack is configured; run scripts/dev-stack.sh up");
  }

  return { convexUrl, mediaServiceKey };
};
