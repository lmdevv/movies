/**
 * `@movies/sdk/promise`: the SDK for code that does not use Effect. It runs the Effect core in a
 * `ManagedRuntime`. Promises reject with the same tagged errors the Effect API fails with
 * (`Unauthenticated`, `NotFound`, `TransportError`, ...), so callers branch on `error._tag`.
 */
import type { CommandArgs, CommandName, CommandResult } from "@movies/contracts/commands";
import type { DeviceId, RoomId } from "@movies/contracts/ids";
import type { EpochMillis } from "@movies/contracts/units";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Scope,
  Stream,
} from "effect";

import * as Auth from "./auth";
import type { AuthStatus } from "./auth";
import * as DeviceLogin from "./device-login";
import * as Movies from "./movies";
import type { ActionName, MediaName, MutationName, QueryName } from "./movies-client";
import { MoviesClient } from "./movies-client";
import * as Playback from "./playback";
import type { PlayerPort } from "./room-sync/player-port";
import * as RoomSync from "./room-sync/room-sync";
import type { RoomSyncState } from "./room-sync/room-sync";
import type { RoomSyncTunables } from "./room-sync/sync-policy";
import { DEFAULT_TUNABLES } from "./room-sync/sync-policy";
import * as TokenStorage from "./token-storage";
import type { KeyValueStore } from "./token-storage";

/** Where to connect and where to keep the session. */
export interface MoviesOptions {
  readonly convexUrl: string;
  /** The media service URL for `media` commands. */
  readonly mediaUrl?: string;
  /** `websocket` (default) for apps; `http` for short-lived scripts. */
  readonly connection?: "websocket" | "http";
  /** Where the session's tokens live; memory when omitted. */
  readonly storage?: KeyValueStore;
  /** The key the session is stored under. */
  readonly storageKey?: string;
}

/** Stops a subscription or a running workflow. */
export type Stop = () => Promise<void>;

/** A pending device sign-in. Show `userCode` and a QR code of `verificationUrl`. */
export interface PendingDeviceLogin {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: EpochMillis;
  /** Resolves once approved and signed in; rejects with `DeviceLoginRefused` when denied or expired. */
  readonly complete: () => Promise<void>;
}

/** Email and password sign-in or sign-up. */
export interface PasswordSignIn {
  readonly flow: "signIn" | "signUp";
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly inviteCode?: string;
}

/** A running room engine. */
export interface RoomSyncHandle {
  readonly current: () => Promise<RoomSyncState>;
  /** Calls `listener` with the current state and every change; returns a function that stops. */
  readonly subscribe: (listener: (state: RoomSyncState) => void) => Stop;
  readonly stop: Stop;
}

/** The SDK as Promises. */
export interface MoviesSdk {
  readonly query: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  readonly mutate: <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  readonly action: <Name extends ActionName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  readonly media: <Name extends MediaName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  readonly run: <Name extends CommandName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /** Calls `onValue` with the query's result now and after every change. */
  readonly subscribe: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
    onValue: (value: CommandResult<Name>) => void,
    onError: (error: Error) => void,
  ) => Stop;
  readonly auth: {
    readonly status: () => Promise<AuthStatus>;
    readonly onStatus: (listener: (status: AuthStatus) => void) => Stop;
    readonly signInWithPassword: (credentials: PasswordSignIn) => Promise<void>;
    readonly signInWithApiKey: (key: string) => Promise<void>;
    readonly startDeviceLogin: (clientName: string) => Promise<PendingDeviceLogin>;
    readonly signOut: () => Promise<void>;
  };
  readonly playback: {
    readonly start: (request: Playback.PlaybackRequest) => Promise<Playback.Playback>;
    /** Reports progress until stopped; stopping ends the session. */
    readonly reportProgress: (playback: Playback.Playback, player: PlayerPort) => Promise<Stop>;
  };
  readonly rooms: {
    readonly sync: (
      roomId: RoomId,
      deviceId: DeviceId,
      player: PlayerPort,
      tunables?: RoomSyncTunables,
    ) => Promise<RoomSyncHandle>;
  };
  /** Closes the connection and stops everything still running. */
  readonly dispose: () => Promise<void>;
}

/** Opens the SDK. The connection opens lazily on the first call. */
export const createMovies = (options: MoviesOptions): MoviesSdk => {
  const storage =
    options.storage === undefined
      ? TokenStorage.layerMemory
      : TokenStorage.layerKeyValue(options.storage, options.storageKey ?? "movies.session");

  const runtime = ManagedRuntime.make(
    Movies.layer({
      convexUrl: options.convexUrl,
      mediaUrl: Option.fromNullishOr(options.mediaUrl),
      connection: options.connection ?? "websocket",
    }).pipe(Layer.provide(storage)),
  );

  const client = <A, E>(f: (client: MoviesClient["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(MoviesClient, f));

  const auth = <A, E>(f: (auth: Auth.Interface) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Auth.Auth, f));

  /** Runs `stream` in the background, calling `listener` per value; the result stops it. */
  const listen = <A, E>(
    stream: Stream.Stream<A, E, Movies.Services>,
    listener: (value: A) => void,
    onError: (error: E) => void,
  ): Stop => {
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (value) => Effect.sync(() => listener(value))).pipe(
        Effect.tapError((error) => Effect.sync(() => onError(error))),
      ),
    );

    return () => runtime.runPromise(Fiber.interrupt(fiber));
  };

  /** Runs a scoped workflow and returns its result with a function that closes its scope. */
  const scoped = async <A, E>(
    workflow: Effect.Effect<A, E, Movies.Services | Scope.Scope>,
  ): Promise<{ readonly value: A; readonly stop: Stop }> => {
    const scope = await runtime.runPromise(Scope.make());

    const stop: Stop = () => runtime.runPromise(Scope.close(scope, Exit.void));

    try {
      return { value: await runtime.runPromise(Scope.provide(scope)(workflow)), stop };
    } catch (error) {
      await stop();

      throw error;
    }
  };

  return {
    query: (name, args) => client((movies) => movies.query(name, args)),
    mutate: (name, args) => client((movies) => movies.mutate(name, args)),
    action: (name, args) => client((movies) => movies.action(name, args)),
    media: (name, args) => client((movies) => movies.media(name, args)),
    run: (name, args) => client((movies) => movies.run(name, args)),
    subscribe: (name, args, onValue, onError) =>
      listen(
        Stream.unwrap(Effect.map(MoviesClient, (movies) => movies.subscribe(name, args))),
        onValue,
        onError,
      ),
    auth: {
      status: () => auth((session) => session.currentStatus),
      onStatus: (listener) =>
        listen(
          Stream.unwrap(Effect.map(Auth.Auth, (session) => session.status)),
          listener,
          () => undefined,
        ),
      signInWithPassword: (credentials) =>
        auth((session) =>
          session.signIn(
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
        auth((session) => session.signIn(Auth.Credentials.ApiKey({ key: Redacted.make(key) }))),
      startDeviceLogin: async (clientName) => {
        const login = await runtime.runPromise(DeviceLogin.start(clientName));

        return {
          userCode: login.userCode,
          verificationUrl: login.verificationUrl,
          expiresAt: login.expiresAt,
          complete: () => runtime.runPromise(login.complete),
        };
      },
      signOut: () => auth((session) => session.signOut),
    },
    playback: {
      start: (request) => runtime.runPromise(Playback.start(request)),
      reportProgress: async (playback, player) =>
        (await scoped(Playback.reportProgress(playback, player))).stop,
    },
    rooms: {
      sync: async (roomId, deviceId, player, tunables = DEFAULT_TUNABLES) => {
        const { value, stop } = await scoped(RoomSync.run({ roomId, deviceId, player, tunables }));

        return {
          current: () => runtime.runPromise(value.current),
          subscribe: (listener) => listen(value.state, listener, () => undefined),
          stop,
        };
      },
    },
    dispose: () => runtime.dispose(),
  };
};
