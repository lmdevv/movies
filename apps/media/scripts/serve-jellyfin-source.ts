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

// The Docker source holds no handle open, so without this the process would exit right away and
// never close its scope, leaving the container running after the caller stops it.
const alive = setInterval(() => undefined, 60_000);

const stop = async (): Promise<void> => {
  clearInterval(alive);
  await source.close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  process.exit(0);
};

process.once("SIGTERM", () => void stop());

process.once("SIGINT", () => void stop());

process.stdout.write(
  `${JSON.stringify({ url: source.url, apiKey: source.apiKey, version: source.version })}\n`,
);
