/**
 * A per-address token bucket on the routes anyone may call without a token: artwork and health.
 * Artwork resizes run ffmpeg, so an unauthenticated flood could keep the CPU busy; everything else
 * needs a playback or bearer token first. The budget is generous for a person browsing a large
 * library (a poster grid loads hundreds of images at once) and refuses a script hammering the
 * route with `429` and `Retry-After`. Behind a reverse proxy every request shares the proxy's
 * address, so the budget is then shared; forwarded headers are not trusted.
 */
import { Clock, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** A route family's budget. */
interface Budget {
  /** Requests a quiet address may send at once. */
  readonly burst: number;
  /** Requests per second the bucket refills by. */
  readonly perSecond: number;
}

/** Budgets by path prefix; other paths are not limited here. */
const BUDGETS: ReadonlyArray<readonly [prefix: string, budget: Budget]> = [
  ["/artwork/", { burst: 600, perSecond: 100 }],
  ["/api/health", { burst: 60, perSecond: 10 }],
];

/** Buckets kept before the least recently used are forgotten. */
const MAX_BUCKETS = 10_000;

interface Bucket {
  readonly tokens: number;
  readonly updatedAt: number;
}

/**
 * Token buckets by key, refilled lazily. At `maxBuckets` the least recently used bucket is
 * forgotten (a quiet address, which has refilled anyway), so many new addresses cannot reset the
 * busy ones.
 */
export const makeLimiter = (maxBuckets = MAX_BUCKETS) => {
  // Kept in order of last use: every take moves its key to the end.
  const buckets = new Map<string, Bucket>();

  /** Takes a token for `key`; returns the seconds to wait when none is left. */
  return (key: string, budget: Budget, now: number): Option.Option<number> => {
    const previous = buckets.get(key) ?? { tokens: budget.burst, updatedAt: now };

    buckets.delete(key);

    if (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next();

      if (oldest.done !== true) buckets.delete(oldest.value);
    }

    const tokens = Math.min(
      budget.burst,
      previous.tokens + ((now - previous.updatedAt) / 1000) * budget.perSecond,
    );

    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAt: now });

      return Option.some(Math.ceil((1 - tokens) / budget.perSecond));
    }

    buckets.set(key, { tokens: tokens - 1, updatedAt: now });

    return Option.none();
  };
};

/** Limits the unauthenticated routes by client address. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.unwrap(
  Effect.sync(() => {
    const take = makeLimiter();

    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const pathname = new URL(request.url, "http://media.invalid").pathname;
          const limited = BUDGETS.find(([prefix]) => pathname.startsWith(prefix));

          if (limited === undefined) return yield* httpEffect;
          const [prefix, budget] = limited;
          const address = Option.getOrElse(request.remoteAddress, () => "unknown");
          const wait = take(`${prefix}\u0000${address}`, budget, yield* Clock.currentTimeMillis);

          return Option.isSome(wait)
            ? HttpServerResponse.text("Too many requests", {
                status: 429,
                headers: { "retry-after": String(wait.value), "cache-control": "no-store" },
              })
            : yield* httpEffect;
        }),
      { global: true },
    );
  }),
);
