import { Schema } from "effect";

import { type FakeFfmpegBehavior, writeFakeFfmpeg } from "../src/testing/fake-ffmpeg.ts";

const seconds = Schema.optionalKey(Schema.Finite);

const decodeBehavior: (json: string) => FakeFfmpegBehavior = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      qsvFailsAfterSeconds: seconds,
      qsvFailsFromSeconds: seconds,
      hlsDelayMs: seconds,
      hlsFailsAtStart: Schema.optionalKey(Schema.Boolean),
      hlsFailsFromSeconds: seconds,
      hlsFromStartSeconds: seconds,
    }),
  ),
);

process.stdout.write(await writeFakeFfmpeg(decodeBehavior(process.argv[2] ?? "{}")));
