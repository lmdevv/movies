/**
 * The real media service for the stack suite: the bundle `apps/media` ships, signed in to the
 * worktree's dev stack with its service key, scanning the suite's fixture folders and serving
 * their artwork on the stack's media port. Stop a media service started with `pnpm dev` first.
 */
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MEDIA_ROUTES } from "@movies/contracts/media-playback";

import { isConnected } from "./media-health";
import type { StackEnv } from "./stack-env";

const mediaDir = fileURLToPath(new URL("../../../media", import.meta.url));

/** How long the service may take to sign in to Convex. */
const START_TIMEOUT_MS = 30_000;

/** Bundles the media service into `apps/media/dist/main.js`. */
export const buildMediaService = (): void => {
  execFileSync(process.execPath, [`${mediaDir}/scripts/build.ts`], { stdio: "pipe" });
};

/** A running media service. */
export interface MediaService {
  /** Stops the service and resolves once it exited. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts the built media service against `stack` with `libraryRoots` approved, and resolves once
 * it is signed in to Convex.
 *
 * @throws When it exits or does not connect in time, with what it logged.
 */
export const startMediaService = async (
  stack: StackEnv,
  libraryRoots: ReadonlyArray<string>,
): Promise<MediaService> => {
  const child = spawn(process.execPath, ["--enable-source-maps", `${mediaDir}/dist/main.js`], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...stack.mediaEnv,
      LIBRARY_ROOTS: libraryRoots.join(","),
      HARDWARE_ACCELERATION: "none",
      MIN_FREE_TRANSCODE_MB: "1",
    },
  });

  let logs = "";

  const collect = (chunk: Buffer): void => {
    logs += chunk.toString("utf8");
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };

  const deadline = Date.now() + START_TIMEOUT_MS;

  const connected = async (): Promise<void> => {
    if (child.exitCode !== null) throw new Error(`The media service exited:\n${logs}`);

    const ready = await fetch(`${stack.mediaUrl}${MEDIA_ROUTES.health}`)
      .then(async (response) => isConnected(await response.text()))
      .catch(() => false);

    if (ready) return;

    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The media service did not connect to Convex:\n${logs}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    await connected();
  };

  await connected();

  return { stop };
};
