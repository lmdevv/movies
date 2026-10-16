# mobile

The [movies] iPhone app: Expo SDK 58 and Expo Router on the shared SDK (`@movies/sdk/react`). It
runs in Expo Go; there is no native build yet.

## Run on an iPhone

The phone must reach the server: the same Wi-Fi, or the same tailnet.

```sh
pnpm install
pnpm --filter mobile start      # Metro; scan the QR code with the iPhone's camera
```

Expo Go opens the app at Connect. Type the server's address, the one people open the web app at:
`movies.home.lan`, `192.168.1.20:8080`, or `http://nas.tailnet.ts.net:8080`. The app asks that
media service for the Convex URL to sign in with (`GET /api/client-config`, from
`CONVEX_PUBLIC_URL`), so the server must set it to an address the phone can reach.

A worktree's dev stack listens on `127.0.0.1` only, so a phone cannot reach it. Use a real server,
or the web preview.

## Web preview

```sh
scripts/dev-stack.sh up                          # then start the media service (apps/media)
pnpm --filter mobile web                         # Expo web on http://localhost:8081
```

Connect to the stack's media URL (`scripts/dev-stack.sh env` prints it). The preview draws Paper's
glass tab bar in JavaScript; the iPhone uses the system tab bar. `/dev/kit` shows every shared
primitive. `pnpm --filter mobile export:web` builds a static copy into `dist/`.

## Layout

| Path               | Role                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `src/app`          | Routes: `connect`, then `(server)` › `(signed-in)` › `(profile)`     |
| `src/theme`        | Paper tokens, type scale, gradients, and fonts                       |
| `src/ui`           | Shared primitives: text, buttons, glass, fields, cards, lists, sheet |
| `src/device`       | What the phone remembers: server, device ID, profile; the keychain   |
| `src/session`      | The chosen profile and the active profile below `(profile)`          |
| `src/art`          | Paper's illustrated artwork for screens before sign-in               |
| `metro.config.mts` | Fails the bundle when React, Convex, or Effect resolve twice         |

`pnpm --filter mobile typecheck` generates Expo Router's typed routes, then runs `tsc`.
