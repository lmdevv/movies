import type { PlaybackSessionId, UserId } from "@movies/contracts/ids";
import { Option } from "effect";

import { makeLimiter } from "./rate-limit.ts";

const SESSION_BUDGET = { burst: 30, perSecond: 0.5 };

const USER_BUDGET = { burst: 60, perSecond: 1 };

/**
 * What a failure is charged to besides its session: an account's own failures, or refusals of an
 * authentic token that expired or is for another purpose. Anyone holding an old leaked token can
 * replay it, so its refusals get an account bucket of their own and never use up the budget of
 * the account's real failures.
 */
export type FailureKind = "failure" | "token-refused";

const ACCOUNT_BUCKETS: Record<FailureKind, string> = {
  failure: "user",
  "token-refused": "refused",
};

interface Suppressed {
  readonly sessionId: PlaybackSessionId;
  readonly userId: UserId;
  readonly count: number;
}

/** A budget of failure records per session and per account. */
export interface FailureBudget {
  /** Whether a `kind` failure of `grant`'s session may be logged at `now`; counts it when not. */
  readonly allow: (
    grant: { readonly sessionId: PlaybackSessionId; readonly userId: UserId },
    kind: FailureKind,
    now: number,
  ) => boolean;
  /** The failures counted since the last call, by session, and forgets them. */
  readonly drain: () => ReadonlyArray<Suppressed>;
}

/** A fresh budget, with every bucket full. */
export const makeFailureBudget = (): FailureBudget => {
  const take = makeLimiter();
  const suppressed = new Map<PlaybackSessionId, Suppressed>();

  return {
    allow: ({ sessionId, userId }, kind, now) => {
      const wait = take(
        [
          [`session\u0000${sessionId}`, SESSION_BUDGET],
          [`${ACCOUNT_BUCKETS[kind]}\u0000${userId}`, USER_BUDGET],
        ],
        now,
      );

      if (Option.isNone(wait)) return true;

      const count = (suppressed.get(sessionId)?.count ?? 0) + 1;

      suppressed.set(sessionId, { sessionId, userId, count });

      return false;
    },
    drain: () => {
      const counted = [...suppressed.values()];

      suppressed.clear();

      return counted;
    },
  };
};
