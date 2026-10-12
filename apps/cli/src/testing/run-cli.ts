/**
 * Runs the CLI in-process with a recording `Output` and an explicit environment, so tests see
 * exactly what a user would without spawning a process or touching the real environment.
 */
import { ConfigProvider, Effect } from "effect";

import { runCli } from "../cli";
import { Output } from "../output";

/** The outcome of one invocation. */
export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `movies <argv>` with only `env` as its environment. */
export const runInProcess = async (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Promise<CliRun> => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];

  const output = Output.of({
    out: (text) =>
      Effect.sync(() => {
        stdout.push(text);
      }),
    err: (text) =>
      Effect.sync(() => {
        stderr.push(text);
      }),
  });

  const code = await Effect.runPromise(
    runCli(argv).pipe(
      Effect.provideService(Output, output),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { ...env } }),
      ),
    ),
  );

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
};
