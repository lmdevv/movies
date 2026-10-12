/**
 * Serves a Jellyfin to migrate from over the generated fixture library in a folder, for the web
 * app's browser tests: the recorded Jellyfin server (`src/migration/testing/jellyfin-fixture.ts`)
 * by default, or with `--docker` a real Jellyfin in Docker set up over the same library
 * (`src/migration/testing/jellyfin-docker.ts`). Either way Jellyfin sees the folder's `movies` and
 * `shows` as `/media/movies` and `/media/shows`.
 *
 * Prints one JSON line, `{ "url", "apiKey", "version" }`, once the server answers, then runs until
 * SIGTERM or SIGINT, when it stops the server (and removes the container).
 *
 *   node scripts/serve-jellyfin-source.ts /tmp/movies-migration [--docker]
 */
import { resolve } from "node:path";

import { Effect, Exit, Scope } from "effect";

import { runOnNode, startJellyfin } from "../src/migration/testing/jellyfin-docker.ts";
import {
  FIXTURE_API_KEY,
  jellyfinRecording,
  startJellyfinFixture,
} from "../src/migration/testing/jellyfin-fixture.ts";
import { generateFixtureLibrary } from "../src/testing/fixture-library.ts";

const workspace = process.argv[2];

if (workspace === undefined) throw new Error("Usage: serve-jellyfin-source.ts <folder> [--docker]");

const root = resolve(workspace);

const scope = Scope.makeUnsafe();

/** Starts the source and returns what callers connect with, and how to stop it. */
const start = async (): Promise<{
  readonly url: string;
  readonly apiKey: string;
  readonly version: string;
  readonly close: () => Promise<void>;
}> => {
  if (process.argv.includes("--docker")) {
    const server = await runOnNode(scope, startJellyfin(root));

    return { ...server, close: () => Promise.resolve() };
  }

  await generateFixtureLibrary(root);

  const server = await startJellyfinFixture();

  return {
    url: server.url,
    apiKey: FIXTURE_API_KEY,
    version: jellyfinRecording.version,
    close: server.close,
  };
};

const source = await start();

const stop = async (): Promise<void> => {
  await source.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  process.exit(0);
};

process.once("SIGTERM", () => void stop());

process.once("SIGINT", () => void stop());

process.stdout.write(
  `${JSON.stringify({ url: source.url, apiKey: source.apiKey, version: source.version })}\n`,
);
