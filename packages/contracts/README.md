# @movies/contracts

Effect Schema contracts shared by the backend, media service, SDK, and CLI. Convex does not import
this package; `packages/backend/test/registry.test.ts` keeps its validators equal to these schemas.

| Entry point                        | What it holds                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@movies/contracts/commands`       | The command registry: every user action with scope, args, result, function                         |
| `@movies/contracts/command`        | Command definition types and helpers                                                               |
| `@movies/contracts/media-service`  | The Convex functions the media service calls, with their schemas                                   |
| `@movies/contracts/models/*`       | DTOs: `account`, `profiles`, `catalog`, `playback`, `rooms`, `jobs`, `scan`, `migration`, `common` |
| `@movies/contracts/ids`            | Branded Convex document IDs and the client `DeviceId`                                              |
| `@movies/contracts/units`          | `Milliseconds`, `EpochMillis`, `Bytes`                                                             |
| `@movies/contracts/scopes`         | Roles, scopes, and how grants and roles combine                                                    |
| `@movies/contracts/errors`         | Failure codes, the wire `CommandFailure`, and one tagged error per code                            |
| `@movies/contracts/media-api`      | The media service's Effect HttpApi (playback negotiation, stream control, health)                  |
| `@movies/contracts/media-playback` | Its routes, request and response schemas, and tagged errors, for clients without Effect HTTP       |
| `@movies/contracts/artwork`        | Artwork keys and `artworkUrl` for images titles, seasons, and episodes carry                       |
| `@movies/contracts/playback-token` | Playback token verifier and signer, and the shared test vectors                                    |
| `@movies/contracts/clock`          | Room clock math, drift classification, and clock offset estimation                                 |
| `@movies/contracts/content-rating` | Certification to minimum age, and the profile rating rule                                          |

Plugin role interfaces are added by the plugin milestone. `media-api` is the only module that uses an
unstable Effect module (`effect/http-api`); import `media-playback` where that is not allowed.
