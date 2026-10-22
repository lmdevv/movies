import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("../..", import.meta.url));

const readEnvFile = (path: string): ReadonlyMap<string, string> => {
  if (!existsSync(path)) return new Map();

  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");

        return separator > 0
          ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
          : [];
      }),
  );
};

const pick = (name: string, file: ReadonlyMap<string, string>): string | undefined =>
  process.env[name] ?? file.get(name);

/** What the stack suite needs. */
export interface StackEnv {
  readonly convexUrl: string;
  readonly mediaUrl: string;
  readonly webPort: number;
  readonly mediaServiceKey: string;
  /** The media service's environment as `scripts/dev-stack.sh` wrote it. */
  readonly mediaEnv: Readonly<Record<string, string>>;
  /** `packages/backend`, where the Convex CLI runs with the stack's admin key. */
  readonly backendDir: string;
}

/** The stack's settings, or null when this worktree has no stack. */
export const stackEnv = (): StackEnv | null => {
  const web = readEnvFile(`${webDir}/.env.local`);
  const media = readEnvFile(`${webDir}/../media/.env.local`);

  const convexUrl = pick("VITE_CONVEX_URL", web);
  const mediaUrl = pick("VITE_MEDIA_BASE_URL", web);
  const webPort = pick("WEB_PORT", web);
  const mediaServiceKey = pick("MEDIA_SERVICE_API_KEY", media);

  if (
    convexUrl === undefined ||
    mediaUrl === undefined ||
    webPort === undefined ||
    mediaServiceKey === undefined
  ) {
    return null;
  }

  return {
    convexUrl,
    mediaUrl,
    webPort: Number(webPort),
    mediaServiceKey,
    mediaEnv: Object.fromEntries(media),
    backendDir: fileURLToPath(new URL("../../../../packages/backend", import.meta.url)),
  };
};
