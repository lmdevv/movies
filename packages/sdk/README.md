# @movies/sdk

The client core shared by the web app, the CLI, and later the native apps. Calls are typed by the
command registry in `@movies/contracts`: arguments are encoded and results decoded with each
command's schemas, and failures are the contracts' tagged errors plus `TransportError` and
`ProtocolError`. No Node built-ins or DOM globals in shipped sources (`import-boundary.test.ts`).

| Entry point           | For                                                               |
| --------------------- | ----------------------------------------------------------------- |
| `@movies/sdk/effect`  | Effect programs: services, layers, workflows                      |
| `@movies/sdk/react`   | React: provider and hooks on the app's `ConvexReactClient`        |
| `@movies/sdk/promise` | Everything else: a Promise facade that rejects with tagged errors |

## Effect

```ts
import { Movies, MoviesClient, TokenStorage } from "@movies/sdk/effect";

const sdk = Movies.layer({
  convexUrl,
  mediaUrl: Option.some(mediaUrl),
  connection: "websocket",
}).pipe(Layer.provide(TokenStorage.layerMemory));

const titles = Effect.flatMap(MoviesClient.MoviesClient, (client) =>
  client.query("titles.list", { profileId }),
);
```

- `MoviesClient`: `query`, `mutate`, `action`, `media` (HTTP to the media service with the
  session's token as bearer), `run` (any command), `subscribe` (a `Stream` of results).
- `Auth`: `signIn(Credentials.Password | ApiKey | DeviceCode)`, `signOut`, `status`, and
  `accessToken(forceRefresh)`; tokens refresh before expiry and when Convex rejects them.
- `DeviceLogin.start(clientName)`: user code, approval URL (render it as a QR code), and
  `complete`, which waits for approval and signs in.
- `TokenStorage`: `layerMemory`, `layerKeyValue(store, key)` for `localStorage`/AsyncStorage, or
  any implementation (the CLI stores a file).
- `Playback`: `start` (create the session, negotiate a stream), `reportProgress` (every ten
  seconds and on pause, resume, seek, and end; ends the session when its scope closes),
  `nextEpisode`, `autoplayCountdown`, `seekStream`, `renegotiate` (renews the playback token when
  it expires within five minutes, then negotiates again), and `recoveryFor`, which maps each
  playback API failure (`@movies/contracts/media-playback`) to what the player does next:
  `reload-playlist`, `renegotiate`, `renew-token`, `new-session`, `retry-later`, `unsupported`,
  or `fail`. Media URLs carry the token, so after renewing load the new `stream.url`.
- `RoomSync.run({ roomId, deviceId, player, tunables })`: the watch room engine (below).
- `ConvexTransport`: `layerWebSocket` for apps, `layerHttp` for short-lived processes.

## Room engine

The engine drives a `PlayerPort`, so the web `<video>` element, hls.js, and native players plug
in through one small adapter:

```ts
interface PlayerPort {
  positionMs(): number;
  isPaused(): boolean;
  isBuffering(): boolean;
  playbackRate(): number;
  setPlaybackRate(rate: number): void;
  seek(positionMs: number): void;
  play(): Promise<void>; // rejects when autoplay is blocked
  pause(): void;
  subscribe(
    listener: (event: "playing" | "paused" | "seeked" | "waiting" | "ended") => void,
  ): () => void;
}
```

It estimates the server clock offset from `rooms.time` round trips (best of a window, by round
trip), applies committed clocks in revision order, nudges the rate for small drift and seeks for
large drift, lets a stalled guest buffer and catch up, publishes the host's play, pause, seek, and
buffering as room commands at the current revision, reverts the host to the committed clock when
a command is stale or after a reconnect, and disables host controls while heartbeats go
unanswered. Tunables live in `RoomSyncPolicy.DEFAULT_TUNABLES`.

## Tests

`pnpm test` runs the unit suites, including the room engine against an in-memory backend and a
fake player on `TestClock`. `pnpm --filter @movies/sdk test:stack` runs the SDK against the dev
stack from `scripts/dev-stack.sh up`.
