import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Reads a UTF-8 file, resolving `null` when it does not exist. */
export const readTextFile = (path: string): Promise<string | null> =>
  readFile(path, "utf8").catch((cause: unknown) => {
    if (isMissing(cause)) return null;

    throw cause instanceof Error ? cause : new Error(`Could not read ${path}`, { cause });
  });

/**
 * Writes a file readable only by the current user (mode 0600) inside a 0700 directory. The write
 * goes to a temporary file first so a crash never leaves half a config behind.
 */
export const writePrivateFile = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temporary = `${path}.${String(process.pid)}.tmp`;

  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

/** Reads all of stdin as UTF-8, for secrets piped in rather than passed as flags. */
export const readStdin = async (): Promise<string> => {
  let text = "";

  for await (const chunk of process.stdin) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }

  return text;
};

/** Runs `program` with `args` attached to this terminal and resolves with its exit code. */
export const runAttached = (program: string, args: ReadonlyArray<string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { stdio: "inherit" });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
