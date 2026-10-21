/**
 * The `movies` executable. No top-level await: the standalone binary embeds this as CommonJS
 * (scripts/build-sea.ts).
 */
import { Effect } from "effect";

import { runCli } from "./cli";
import { Output, processOutput } from "./output";

Effect.runFork(
  runCli(process.argv.slice(2)).pipe(
    Effect.provideService(Output, processOutput),
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
  ),
);
