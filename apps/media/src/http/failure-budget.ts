/**
 * How many failed media requests each playback session and each account may write to the
 * retained log. A verified token makes a failure worth a `WARN` record, but a member can send any
 * number of failing requests with their own token; without a budget they could rotate every other
 * record out of the log. Failures past the budget are counted instead, by session, and the counts
 * are logged together a few times a minute.
 */
import type { PlaybackSessionId, UserId } from "@movies/contracts/ids";
import { Option } from "effect";

import { makeLimiter } from "./rate-limit.ts";

/** Failures one session may log at once, and how many more each second after that. */
const SESSION_BUDGET = { burst: 30, perSecond: 0.5 };

/** The same for all of one account's sessions together. */
const USER_BUDGET = { burst: 60, perSecond: 1 };

/** Failures of one session that were counted rather than logged. */
interface Suppressed {
  readonly sessionId: PlaybackSessionId;
  readonly userId: UserId;
  readonly count: number;
}

/** A budget of failure records per session and per account. */
export interface FailureBudget {
  /** Whether a failure of `grant`'s session may be logged at `now`; counts it when not. */
  readonly allow: (
    grant: { readonly sessionId: PlaybackSessionId; readonly userId: UserId },
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
    allow: ({ sessionId, userId }, now) => {
      const wait = take(
        [
          [`session\u0000${sessionId}`, SESSION_BUDGET],
          [`user\u0000${userId}`, USER_BUDGET],
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
