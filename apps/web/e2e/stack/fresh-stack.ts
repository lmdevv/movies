import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";

import { stackEnv } from "./stack-env";
import type { StackEnv } from "./stack-env";

const SetupStatus = Schema.Struct({ hasOwner: Schema.Boolean });

/**
 * The worktree's stack when it is reachable and still at first run (no owner), which the suite's
 * first-run test needs; null otherwise, so the suite skips.
 */
export const freshStack = async (): Promise<StackEnv | null> => {
  const stack = stackEnv();

  if (stack === null) return null;

  try {
    const client = new ConvexHttpClient(stack.convexUrl, { logger: false });

    const status = Schema.decodeUnknownSync(SetupStatus)(
      await client.query(makeFunctionReference<"query">("setup:status"), {}),
    );

    return status.hasOwner ? null : stack;
  } catch {
    return null;
  }
};
