/**
 * Runs ffprobe and ffmpeg through Effect's `ChildProcessSpawner`. Arguments are always built by
 * this service's callers from server-side state; nothing here accepts client-supplied arguments.
 */
import { Context, Effect, Fiber, Layer, Ref, type Scope, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as MediaConfig from "../media-config.ts";

/** A media tool could not start, or exited unsuccessfully. */
export class MediaToolFailed extends Schema.TaggedError<MediaToolFailed>()("MediaToolFailed", {
  tool: Schema.Literals(["ffmpeg", "ffprobe"]),
  exitCode: Schema.NullOr(Schema.Int),
  /** Tail of the tool's standard error with absolute paths from its arguments replaced. */
  stderr: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media tool failed: ${this.tool} exited with ${String(this.exitCode)}: ${this.stderr.trim().slice(-400)}`;
  }
}

/** A long-running ffmpeg process owned by the scope it was started in. */
interface RunningTool {
  /** Waits for the process to exit; fails with `MediaToolFailed` on a non-zero exit. */
  readonly exit: Effect.Effect<void, MediaToolFailed>;
  /** The latest standard error output, path-scrubbed. */
  readonly stderrTail: Effect.Effect<string>;
}

/** ffprobe and ffmpeg. */
export interface Interface {
  /** Runs ffprobe to completion and returns its standard output. */
  readonly ffprobe: (args: ReadonlyArray<string>) => Effect.Effect<string, MediaToolFailed>;
  /** Runs ffmpeg to completion and returns its standard output. */
  readonly ffmpeg: (args: ReadonlyArray<string>) => Effect.Effect<string, MediaToolFailed>;
  /**
   * Starts ffmpeg in the current scope. Closing the scope kills the whole process group with
   * `SIGKILL`; its output is disposable.
   */
  readonly startFfmpeg: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<RunningTool, MediaToolFailed, Scope.Scope>;
}

/** The media tools. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/MediaTools") {}

const STDERR_TAIL = 4096;

/** Replaces absolute paths that appear in the arguments, so diagnostics do not leak them. */
const scrubPaths = (text: string, args: ReadonlyArray<string>): string =>
  args
    .filter((arg) => arg.startsWith("/") && arg.length > 1)
    .toSorted((left, right) => right.length - left.length)
    .reduce((scrubbed, path) => scrubbed.replaceAll(path, "<path>"), text);

/** Builds the media tools over a child process spawner. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fnUntraced(function* (
    tool: "ffmpeg" | "ffprobe",
    args: ReadonlyArray<string>,
    killSignal: "SIGKILL" | "SIGTERM",
  ) {
    const failed = (exitCode: number | null, stderr: string, cause: unknown) =>
      new MediaToolFailed({ tool, exitCode, stderr: scrubPaths(stderr, args), cause });

    const command = ChildProcess.make(
      tool === "ffmpeg" ? config.ffmpegPath : config.ffprobePath,
      args,
      {
        stdin: "ignore",
        killSignal,
        forceKillAfter: "2 seconds",
      },
    );

    const handle = yield* spawner
      .spawn(command)
      .pipe(Effect.mapError((cause) => failed(null, "", cause)));

    const stderr = yield* Ref.make("");

    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderr, (tail) => (tail + chunk).slice(-STDERR_TAIL)),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    const stdout = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError((cause) => failed(null, "", cause)),
      Effect.forkScoped,
    );

    const exit = Effect.gen(function* () {
      const code = yield* handle.exitCode.pipe(Effect.mapError((cause) => failed(null, "", cause)));

      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* failed(code, yield* Ref.get(stderr), null);
      }

      return yield* Fiber.join(stdout);
    });

    return { exit, stderrTail: Ref.get(stderr).pipe(Effect.map((text) => scrubPaths(text, args))) };
  });

  const runToCompletion = (tool: "ffmpeg" | "ffprobe") =>
    Effect.fn(`MediaTools.${tool}`)(function* (args: ReadonlyArray<string>) {
      const running = yield* spawn(tool, args, "SIGKILL");

      return yield* running.exit;
    }, Effect.scoped);

  const startFfmpeg = Effect.fn("MediaTools.startFfmpeg")(function* (args: ReadonlyArray<string>) {
    const running = yield* spawn("ffmpeg", args, "SIGKILL");

    return {
      exit: Effect.asVoid(running.exit),
      stderrTail: running.stderrTail,
    } satisfies RunningTool;
  });

  return Service.of({
    ffprobe: runToCompletion("ffprobe"),
    ffmpeg: runToCompletion("ffmpeg"),
    startFfmpeg,
  });
});

/** Media tools over the platform's child process spawner. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Service, make);
