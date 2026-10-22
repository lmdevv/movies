import { Clock, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

interface Budget {
  readonly burst: number;
  readonly perSecond: number;
}

const BUDGETS: ReadonlyArray<readonly [prefix: string, budget: Budget]> = [
  ["/artwork/", { burst: 600, perSecond: 100 }],
  ["/api/health", { burst: 60, perSecond: 10 }],
  ["/api/client-config", { burst: 60, perSecond: 10 }],
];

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
  const buckets = new Map<string, Bucket>();

  return (
    keyed: ReadonlyArray<readonly [key: string, budget: Budget]>,
    now: number,
    cost = 1,
  ): Option.Option<number> => {
    const refilled = keyed.map(([key, budget]) => {
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

      return { key, budget, tokens };
    });

    const waits = refilled.flatMap(({ budget, tokens }) =>
      tokens < cost ? [Math.ceil((cost - tokens) / budget.perSecond)] : [],
    );

    for (const { key, tokens } of refilled) {
      buckets.set(key, { tokens: waits.length === 0 ? tokens - cost : tokens, updatedAt: now });
    }

    return waits.length === 0 ? Option.none() : Option.some(Math.max(...waits));
  };
};

/** `response` telling its client to wait `seconds` before it tries again. */
export const retryAfter = (
  response: HttpServerResponse.HttpServerResponse,
  seconds: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(response, "retry-after", String(seconds));

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

          const wait = take(
            [[`${prefix}\u0000${address}`, budget]],
            yield* Clock.currentTimeMillis,
          );

          return Option.isSome(wait)
            ? retryAfter(
                HttpServerResponse.text("Too many requests", {
                  status: 429,
                  headers: { "cache-control": "no-store" },
                }),
                wait.value,
              )
            : yield* httpEffect;
        }),
      { global: true },
    );
  }),
);
