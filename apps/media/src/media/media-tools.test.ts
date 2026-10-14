import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Exit, FileSystem, Layer } from "effect";

import { testConfigLayer } from "../testing/test-config.ts";
import * as MediaTools from "./media-tools.ts";

/** `env` stands in for ffprobe, so the test reads the environment the tools really get. */
const toolsLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFPROBE_PATH: "/usr/bin/env" })),
  Layer.provide(NodeServices.layer),
);

/** `sleep` stands in for ffmpeg, so a run never finishes on its own. */
const hangingLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFMPEG_PATH: "sleep", PROBE_TIMEOUT_SECONDS: "1" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Whether a process with exactly these arguments is running. */
const running = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const wanted = args.join("\0");
  const pids = (yield* fs.readDirectory("/proc")).filter((name) => /^\d+$/.test(name));

  const commands = yield* Effect.forEach(pids, (pid) =>
    fs.readFileString(`/proc/${pid}/cmdline`).pipe(Effect.orElseSucceed(() => "")),
  );

  return commands.some((cmdline) => cmdline.replace(/\0$/, "").endsWith(wanted));
});

describe("media tools", () => {
  it("passes on only the variables the tools need", () => {
    assert.deepStrictEqual(
      MediaTools.toolEnvironment({
        PATH: "/usr/bin",
        LIBVA_DRIVERS_PATH: "/run/opengl-driver/lib/dri",
        MEDIA_SERVICE_API_KEY: "mk_service_secret",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-self-hosted|secret",
        PLAYBACK_TOKEN_SECRET: "secret",
        TZ: undefined,
      }),
      { PATH: "/usr/bin", LIBVA_DRIVERS_PATH: "/run/opengl-driver/lib/dri" },
    );
  });

  layer(toolsLayer)((tools) => {
    tools.effect("runs the tools without the service's credentials", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;
        const listed = yield* service.ffprobe([]);

        const names = listed
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => line.slice(0, line.indexOf("=")));

        assert.include(names, "PATH");
        assert.notInclude(names, "MEDIA_SERVICE_API_KEY");
        assert.isTrue(names.every((name) => !name.includes("KEY") && !name.includes("SECRET")));
      }),
    );
  });

  layer(hangingLayer, { excludeTestServices: true })((tools) => {
    tools.effect("kills a run that outlives its timeout", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;
        const marker = ["86399.25"];
        const exit = yield* service.ffmpeg(marker).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "timed out after 1 seconds");

        const shorter = yield* service
          .ffmpeg(["86399.5"], { timeout: Duration.millis(200) })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(shorter));
        assert.isFalse(yield* running(marker));
      }),
    );

    tools.effect("lets background work run past the probe timeout", () =>
      Effect.gen(function* () {
        const service = yield* MediaTools.Service;

        // Scrub thumbnails of a whole film take minutes; only an explicit timeout bounds them.
        assert.isTrue(Exit.isSuccess(yield* service.ffmpegInBackground(["1.5"]).pipe(Effect.exit)));
      }),
    );
  });
});
