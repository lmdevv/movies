/**
 * The local dev stack for browser tests: `scripts/dev-stack.sh up` writes this app's
 * `.env.local`. Suites that need a backend call `test.skip(stack === undefined, …)`, so
 * `pnpm test:e2e` stays green without Docker. Run them with `MOVIES_STACK_TESTS=1`.
 *
 * Sessions come from the real SDK: the test signs in over HTTP, then hands the stored session to
 * the page's `localStorage`, exactly where the app keeps its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createMovies } from "@movies/sdk/promise";
import type { MoviesSdk } from "@movies/sdk/promise";
import type { Page } from "@playwright/test";

/** Where the stack answers. */
export interface Stack {
  readonly convexUrl: string;
  readonly mediaUrl: string;
}

const readEnvFile = (path: string): ReadonlyMap<string, string> =>
  existsSync(path)
    ? new Map(
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line) => {
            const separator = line.indexOf("=");

            return separator > 0
              ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
              : [];
          }),
      )
    : new Map();

const findStack = (): Stack | undefined => {
  if (process.env["MOVIES_STACK_TESTS"] !== "1") return undefined;

  const env = readEnvFile(join(import.meta.dirname, "..", ".env.local"));
  const convexUrl = process.env["VITE_CONVEX_URL"] ?? env.get("VITE_CONVEX_URL");
  const mediaUrl = process.env["VITE_MEDIA_BASE_URL"] ?? env.get("VITE_MEDIA_BASE_URL");

  return convexUrl === undefined || mediaUrl === undefined ? undefined : { convexUrl, mediaUrl };
};

/** The stack under test, or undefined when stack tests are off. */
export const stack = findStack();

/** Why stack suites skip. */
export const NO_STACK = "needs MOVIES_STACK_TESTS=1 and scripts/dev-stack.sh up";

/** The password every test account uses; it is a throwaway on a local stack. */
const PASSWORD = "stack-test-password";

/** The owner accounts the backend and SDK stack suites share. */
const OWNER_EMAILS = ["owner-a@movies.test", "owner-b@movies.test"] as const;

const SESSION_KEY = "movies.session";

/** An SDK client with its own in-memory store, and that store's serialized session. */
export interface Client {
  readonly sdk: MoviesSdk;
  /** The stored session as the app keeps it in `localStorage`. */
  readonly session: () => string;
}

/** Opens an SDK client against the stack, signed out. */
export const openClient = (target: Stack): Client => {
  const store = new Map<string, string>();

  const sdk = createMovies({
    convexUrl: target.convexUrl,
    mediaUrl: target.mediaUrl,
    connection: "http",
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
    storageKey: SESSION_KEY,
  });

  return {
    sdk,
    session: () => {
      const value = store.get(SESSION_KEY);

      if (value === undefined) throw new Error("The test client is not signed in");

      return value;
    },
  };
};

/** Signs in as the stack's owner, creating it on an empty backend. */
export const signInOwner = async (target: Stack): Promise<Client> => {
  const client = openClient(target);
  const status = await client.sdk.query("setup.status", {});

  if (!status.hasOwner) {
    await client.sdk.auth.signInWithPassword({
      flow: "signUp",
      email: OWNER_EMAILS[0],
      password: PASSWORD,
      name: "Alex",
    });

    return client;
  }

  // The shared owner accounts are tried in order.
  const tryOwners = async (emails: ReadonlyArray<string>): Promise<Client> => {
    const [email, ...rest] = emails;

    if (email === undefined) {
      throw new Error("The backend has an owner from elsewhere; use a fresh stack");
    }

    return client.sdk.auth.signInWithPassword({ flow: "signIn", email, password: PASSWORD }).then(
      () => client,
      () => tryOwners(rest),
    );
  };

  return tryOwners(OWNER_EMAILS);
};

/** The stack's media service key, from `apps/media/.env.local` or the environment. */
export const mediaServiceKey = (): string => {
  const key =
    process.env["MEDIA_SERVICE_API_KEY"] ??
    readEnvFile(join(import.meta.dirname, "..", "..", "media", ".env.local")).get(
      "MEDIA_SERVICE_API_KEY",
    );

  if (key === undefined || key === "") throw new Error("No MEDIA_SERVICE_API_KEY for the stack");

  return key;
};

/** Makes `page` start signed in as `client` on its next navigation. */
export const useSession = async (page: Page, client: Client): Promise<void> => {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [SESSION_KEY, client.session()] as const,
  );
};
