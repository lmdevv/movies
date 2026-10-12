import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { testConfigLayer } from "../testing/test-config.ts";
import * as MediaTools from "./media-tools.ts";

/** `env` stands in for ffprobe, so the test reads the environment the tools really get. */
const toolsLayer = MediaTools.layer.pipe(
  Layer.provide(testConfigLayer({ FFPROBE_PATH: "/usr/bin/env" })),
  Layer.provide(NodeServices.layer),
);

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
});
