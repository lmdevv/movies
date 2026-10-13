/**
 * A live query outside React, for `useCommandQuery`: its latest state, change notifications for
 * `useSyncExternalStore`, and a retry. Failures that may pass by themselves (the network, a crashed
 * function, rate limiting) retry with backoff before the query reports them; the rest, such as
 * not found or forbidden, report at once. A failed query stays failed until `retry` runs.
 */
import type { CommandArgs, CommandResult } from "@movies/contracts/commands";
import type { Duration, ManagedRuntime } from "effect";
import { Effect, Fiber, Predicate, Schedule, Stream } from "effect";

import { MoviesClient } from "./movies-client";
import type { QueryName } from "./movies-client";
import type { CallError } from "./sdk-errors";

/**
 * A query's state: loading, its decoded result, or a typed failure with a way to subscribe again.
 * A query that fails after showing a result reports the failure in place of the result.
 */
export type QueryState<A> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: A }
  | {
      readonly status: "error";
      readonly error: CallError;
      /** Subscribes again from `loading`, such as from a Try again button. */
      readonly retry: () => void;
    };

/** One query's state and its listeners. The query runs while at least one listener is attached. */
export interface QueryWatch<A> {
  /** Adds a listener, starting the query for the first; returns its removal. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** The current state; the same object until it changes. */
  readonly getSnapshot: () => QueryState<A>;
}

const LOADING = { status: "loading" } as const;

/** A query that waits, such as one passed `"skip"`: loading, with nothing to subscribe to. */
export const skipped: QueryWatch<never> = {
  subscribe: () => () => undefined,
  getSnapshot: () => LOADING,
};

/** Failures a query retries by itself: they may pass without anyone changing anything. */
const isTransient = (error: CallError): boolean =>
  Predicate.isTagged(error, "TransportError") ||
  Predicate.isTagged(error, "Internal") ||
  Predicate.isTagged(error, "RateLimited");

/**
 * Four retries about 0.5, 1, 2 and 4 seconds apart, for transient failures only. The count starts
 * over once a result arrives, so a long-lived query survives occasional drops.
 */
const retryTransient: Schedule.Schedule<Duration.Duration, CallError> = Schedule.exponential(
  "500 millis",
).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 4 }),
  Schedule.while(({ input }: { readonly input: CallError }) => isTransient(input)),
);

/**
 * Builds a watch of query `name` with `args`, run on `runtime`. Nothing runs until the first
 * listener subscribes, and the subscription closes when the last one leaves.
 */
export const make = <Name extends QueryName>(
  runtime: ManagedRuntime.ManagedRuntime<MoviesClient, unknown>,
  name: Name,
  args: CommandArgs<Name>,
): QueryWatch<CommandResult<Name>> => {
  const listeners = new Set<() => void>();
  let state: QueryState<CommandResult<Name>> = LOADING;
  let running: Fiber.Fiber<void, unknown> | null = null;

  const publish = (next: QueryState<CommandResult<Name>>): void => {
    state = next;

    for (const listener of listeners) listener();
  };

  const start = (): void => {
    running = runtime.runFork(
      Stream.unwrap(Effect.map(MoviesClient, (client) => client.subscribe(name, args))).pipe(
        Stream.retry(retryTransient),
        Stream.runForEach((data) => Effect.sync(() => publish({ status: "success", data }))),
        Effect.catch((error) => Effect.sync(() => publish({ status: "error", error, retry }))),
      ),
    );
  };

  const stop = (): void => {
    if (running === null) return;

    runtime.runFork(Fiber.interrupt(running));
    running = null;
  };

  const retry = (): void => {
    if (listeners.size === 0) return;

    stop();
    publish(LOADING);
    start();
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);

      // Coming back after everyone left subscribes afresh; an old failure would offer a stale retry.
      if (listeners.size === 1) {
        if (state.status === "error") state = LOADING;
        start();
      }

      return () => {
        listeners.delete(onChange);

        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => state,
  };
};
