/** Where the CLI writes. Results go to stdout; errors, progress, and prompts go to stderr. */
import { Context, Effect } from "effect";

/** Writes lines to the process streams. */
export interface Interface {
  readonly out: (text: string) => Effect.Effect<void>;
  readonly err: (text: string) => Effect.Effect<void>;
}

/** The CLI's output streams. */
export class Output extends Context.Service<Output, Interface>()("@movies/cli/Output") {}

/** Writes to the process streams, one line per call. */
export const processOutput: Interface = Output.of({
  out: (text) =>
    Effect.sync(() => {
      process.stdout.write(`${text}\n`);
    }),
  err: (text) =>
    Effect.sync(() => {
      process.stderr.write(`${text}\n`);
    }),
});
