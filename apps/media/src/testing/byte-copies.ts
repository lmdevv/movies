import { Effect, FileSystem, Path, type PlatformError } from "effect";

// `FileSystem.copyFile` and `copy` go through libuv's copyfile, which calls `fchown`. The NixOS
// unit's system call filter denies it, and scripts/check-sandbox.sh runs the tests under that
// filter, so test fixtures copy by writing bytes as the service does.

/** Copies the file at `from` to `to` by writing its bytes. */
export const copyBytes = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFile(to, yield* fs.readFile(from));
});

/** Copies the folder at `from`, which holds only folders and files, to `to`. */
export const copyTree: (
  from: string,
  to: string,
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (from: string, to: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(to, { recursive: true });

    for (const name of yield* fs.readDirectory(from)) {
      const source = path.join(from, name);
      const target = path.join(to, name);
      const info = yield* fs.stat(source);

      yield* info.type === "Directory" ? copyTree(source, target) : copyBytes(source, target);
    }
  });
