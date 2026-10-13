/**
 * `@movies/sdk/react`: the SDK in React. `MoviesProvider` runs the Effect core on the app's
 * `ConvexReactClient`, so `convex/react` subscriptions and the SDK share one WebSocket. Queries
 * are typed by command name and return a state instead of throwing; commands return Promises that
 * reject with the SDK's tagged errors.
 */
import type { CommandArgs, CommandName, CommandResult } from "@movies/contracts/commands";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import type { ConvexReactClient } from "convex/react";
import { ConvexProvider } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Scope,
  Stream,
} from "effect";
import type { Schema } from "effect";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import * as Auth from "./auth";
import type { AuthStatus } from "./auth";
import * as ConvexTransport from "./convex-transport";
import type { AuthTokenSource, ClientAdapter, WireArgs } from "./convex-transport";
import * as DeviceLogin from "./device-login";
import type { PlaybackCallError } from "./media-http";
import * as Movies from "./movies";
import type { QueryName } from "./movies-client";
import { MoviesClient } from "./movies-client";
import * as Playback from "./playback";
import * as QueryWatch from "./query-watch";
import type { QueryState } from "./query-watch";
import type { PlayerPort } from "./room-sync/player-port";
import * as RoomSync from "./room-sync/room-sync";
import type { RoomSyncState } from "./room-sync/room-sync";
import type { RoomSyncTunables } from "./room-sync/sync-policy";
import { DEFAULT_TUNABLES } from "./room-sync/sync-policy";
import type { CallError } from "./sdk-errors";
import * as TokenStorage from "./token-storage";
import type { KeyValueStore } from "./token-storage";

type Runtime = ManagedRuntime.ManagedRuntime<Movies.Services, Movies.OpenError>;

const RuntimeContext = createContext<Runtime | null>(null);

/** Adapts the app's React client; the app owns it, so closing the SDK leaves it open. */
const reactAdapter = (client: ConvexReactClient): ClientAdapter => ({
  call: (kind, path, args) => {
    if (kind === "query")
      return client.query(makeFunctionReference<"query", WireArgs, Schema.Json>(path), args);

    if (kind === "mutation") {
      return client.mutation(makeFunctionReference<"mutation", WireArgs, Schema.Json>(path), args);
    }

    return client.action(makeFunctionReference<"action", WireArgs, Schema.Json>(path), args);
  },
  subscribe: (path, args, onValue, onError) => {
    const watch = client.watchQuery(
      makeFunctionReference<"query", WireArgs, Schema.Json>(path),
      args,
    );

    const read = (): void => {
      try {
        const value = watch.localQueryResult();

        if (value !== undefined) onValue(value);
      } catch (cause) {
        onError(cause instanceof Error ? cause : new Error("Query failed", { cause }));
      }
    };

    const unsubscribe = watch.onUpdate(read);

    read();

    return unsubscribe;
  },
  setAuth: (source: AuthTokenSource | null) => {
    if (source === null) client.clearAuth();
    else client.setAuth(({ forceRefreshToken }) => source(forceRefreshToken));
  },
  close: () => Promise.resolve(),
});

/** Props for `MoviesProvider`. */
export interface MoviesProviderProps {
  /** The app's Convex client; `convex/react` hooks below the provider use it too. */
  readonly client: ConvexReactClient;
  /** The media service URL for `media` commands. */
  readonly mediaUrl?: string;
  /** Where the session lives, such as `window.localStorage`. */
  readonly storage: KeyValueStore;
  readonly storageKey?: string;
  readonly children: ReactNode;
}

/**
 * Provides the SDK and the Convex client to the tree. The runtime is created and disposed by one
 * effect, so React's development double mount (StrictMode) never leaves a disposed runtime in
 * use; children render once it exists.
 */
export const MoviesProvider = (props: MoviesProviderProps): ReactNode => {
  const { client, mediaUrl, storage, storageKey } = props;
  const [runtime, setRuntime] = useState<Runtime | null>(null);

  useEffect(() => {
    const created = ManagedRuntime.make(
      Movies.layerWithTransport({
        convexUrl: client.url,
        mediaUrl: Option.fromNullishOr(mediaUrl),
      }).pipe(
        Layer.provide(
          Layer.effect(ConvexTransport.ConvexTransport, ConvexTransport.make(reactAdapter(client))),
        ),
        Layer.provide(TokenStorage.layerKeyValue(storage, storageKey ?? "movies.session")),
      ),
    );

    setRuntime(created);

    return () => {
      setRuntime(null);
      void created.dispose();
    };
  }, [client, mediaUrl, storage, storageKey]);

  if (runtime === null) return null;

  return (
    <ConvexProvider client={client}>
      <RuntimeContext.Provider value={runtime}>{props.children}</RuntimeContext.Provider>
    </ConvexProvider>
  );
};

/**
 * The SDK runtime, for running Effect workflows from components.
 *
 * @throws When used outside `MoviesProvider`, a programming error.
 */
export const useMoviesRuntime = (): Runtime => {
  const runtime = useContext(RuntimeContext);

  if (runtime === null) throw new Error("useMoviesRuntime must be used inside MoviesProvider");

  return runtime;
};

export type { QueryState } from "./query-watch";

/**
 * Subscribes to a query command, re-rendering on every change. Pass `"skip"` to wait. Arguments
 * the schema rejects report an `InvalidArgs` error without subscribing. Network failures and
 * crashed functions retry with backoff first; a failure carries `retry` for a Try again button.
 */
export const useCommandQuery = <Name extends QueryName>(
  name: Name,
  args: CommandArgs<Name> | "skip",
): QueryState<CommandResult<Name>> => {
  const runtime = useMoviesRuntime();
  // The subscription restarts only when the arguments' content changes.
  const key = args === "skip" ? null : `${name}:${JSON.stringify(args)}`;

  const watch = useMemo(
    (): QueryWatch.QueryWatch<CommandResult<Name>> =>
      args === "skip" ? QueryWatch.skipped : QueryWatch.make(runtime, name, args),
    [runtime, key],
  );

  return useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
};

/** Returns a function that runs any command and resolves with its decoded result. */
export const useCommand = <Name extends CommandName>(
  name: Name,
): ((args: CommandArgs<Name>) => Promise<CommandResult<Name>>) => {
  const runtime = useMoviesRuntime();

  return useCallback(
    (args) => runtime.runPromise(Effect.flatMap(MoviesClient, (client) => client.run(name, args))),
    [runtime, name],
  );
};

/** The session's sign-in state and the ways to change it. */
export interface UseAuth {
  readonly status: AuthStatus;
  readonly signInWithPassword: (credentials: {
    readonly flow: "signIn" | "signUp";
    readonly email: string;
    readonly password: string;
    readonly name?: string;
    readonly inviteCode?: string;
  }) => Promise<void>;
  readonly signInWithApiKey: (key: string) => Promise<void>;
  readonly startDeviceLogin: (clientName: string) => Promise<{
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly complete: () => Promise<void>;
  }>;
  readonly signOut: () => Promise<void>;
}

/** Signs in and out and reports the session's status. */
export const useAuth = (): UseAuth => {
  const runtime = useMoviesRuntime();

  const store = useMemo(() => {
    let status: AuthStatus = "loading";

    return {
      subscribe: (onChange: () => void) => {
        const fiber = runtime.runFork(
          Stream.runForEach(Stream.unwrap(Effect.map(Auth.Auth, (auth) => auth.status)), (next) =>
            Effect.sync(() => {
              status = next;
              onChange();
            }),
          ),
        );

        return () => {
          runtime.runFork(Fiber.interrupt(fiber));
        };
      },
      read: () => status,
    };
  }, [runtime]);

  const status = useSyncExternalStore(store.subscribe, store.read, store.read);

  return useMemo((): UseAuth => {
    const withAuth = <A, E>(f: (auth: Auth.Interface) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(Auth.Auth, f));

    return {
      status,
      signInWithPassword: (credentials) =>
        withAuth((auth) =>
          auth.signIn(
            Auth.Credentials.Password({
              flow: credentials.flow,
              email: credentials.email,
              password: Redacted.make(credentials.password),
              name: Option.fromNullishOr(credentials.name),
              inviteCode: Option.fromNullishOr(credentials.inviteCode),
            }),
          ),
        ),
      signInWithApiKey: (key) =>
        withAuth((auth) => auth.signIn(Auth.Credentials.ApiKey({ key: Redacted.make(key) }))),
      startDeviceLogin: async (clientName) => {
        const login = await runtime.runPromise(DeviceLogin.start(clientName));

        return {
          userCode: login.userCode,
          verificationUrl: login.verificationUrl,
          complete: () => runtime.runPromise(login.complete),
        };
      },
      signOut: () => withAuth((auth) => auth.signOut),
    };
  }, [runtime, status]);
};

/**
 * Runs a scoped workflow while `key` stays the same, closing it on change or unmount. Returns the
 * workflow's value once started, or its failure.
 */
const useScoped = <A, E>(
  key: string | null,
  workflow: () => Effect.Effect<A, E, Movies.Services | Scope.Scope>,
): Result.Result<A, E> | null => {
  const runtime = useMoviesRuntime();
  const [outcome, setOutcome] = useState<Result.Result<A, E> | null>(null);

  useEffect(() => {
    if (key === null) return () => undefined;
    let active = true;
    const scope = Scope.makeUnsafe();

    const fiber = runtime.runFork(
      Scope.provide(scope)(workflow()).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            if (active) setOutcome(result);
          }),
        ),
      ),
    );

    return () => {
      active = false;
      setOutcome(null);
      runtime.runFork(Effect.andThen(Fiber.interrupt(fiber), Scope.close(scope, Exit.void)));
    };
    // The key stands for the workflow's inputs.
  }, [runtime, key]);

  return outcome;
};

/** What `useRoomSync` needs. */
export interface RoomSyncInput {
  readonly roomId: RoomId;
  readonly deviceId: DeviceId;
  readonly tunables?: RoomSyncTunables;
}

/**
 * Keeps `player` on the room's shared timeline while mounted. Returns the engine's state, null
 * while starting or without a player, or the failure that kept it from starting.
 */
export const useRoomSync = (
  player: PlayerPort | null,
  input: RoomSyncInput | null,
): Result.Result<RoomSyncState, CallError> | null => {
  const runtime = useMoviesRuntime();
  const [state, setState] = useState<RoomSyncState | null>(null);
  const key = player === null || input === null ? null : `${input.roomId}:${input.deviceId}`;

  const started = useScoped(key, () =>
    Effect.gen(function* () {
      if (player === null || input === null) return yield* Effect.die(new Error("No room input"));

      const sync = yield* RoomSync.run({
        roomId: input.roomId,
        deviceId: input.deviceId,
        player,
        tunables: input.tunables ?? DEFAULT_TUNABLES,
      });

      yield* Effect.forkScoped(
        Stream.runForEach(sync.state, (next) => Effect.sync(() => setState(next))),
      );

      return sync;
    }),
  );

  useEffect(() => {
    if (key === null) setState(null);
  }, [key, runtime]);

  if (started === null) return null;

  if (Result.isFailure(started)) return Result.fail(started.failure);

  return state === null ? null : Result.succeed(state);
};

/**
 * Starts playback for `request` and reports progress from `player` while mounted; unmounting ends
 * the session. Returns the negotiated playback, null while starting, or the failure.
 */
export const usePlaybackSession = (
  request: Playback.PlaybackRequest | null,
  player: PlayerPort | null,
): Result.Result<Playback.Playback, CallError | PlaybackCallError> | null => {
  const key =
    request === null || player === null
      ? null
      : JSON.stringify([
          request.profileId,
          request.deviceId,
          request.titleId,
          Option.getOrNull(request.episodeId),
          Option.getOrNull(request.fileId),
          Option.getOrNull(request.roomId),
        ]);

  return useScoped(key, () =>
    Effect.gen(function* () {
      if (request === null || player === null) {
        return yield* Effect.die(new Error("No playback input"));
      }

      const playback = yield* Playback.start(request);

      yield* Playback.reportProgress(playback, player);

      return playback;
    }),
  );
};
