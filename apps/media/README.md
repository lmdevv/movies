# @movies/media

Node + Effect HttpApi media service. It scans approved library folders, probes files with
ffprobe, merges local NFO/artwork with TMDB metadata, negotiates playback, serves direct files
with byte ranges, produces fMP4 HLS (remux, audio-only transcode, Intel QSV transcode with HDR
tone mapping, or software transcode capped at 1080p), converts text subtitles to WebVTT, and
hosts the built web app.

```sh
pnpm --filter @movies/media dev        # bundle, watch, and run with .env.local
pnpm --filter @movies/media build      # dist/main.js
pnpm --filter @movies/media start      # node dist/main.js
pnpm --filter @movies/media fixtures /tmp/movies-fixtures   # generated test library
```

Until the Convex integration lands, the service runs in standalone mode: each `LIBRARY_ROOTS`
entry is scanned into an in-memory store and kept in sync, and playback events are logged.

## HTTP

| Route                                                    | Purpose                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/playback/negotiate`                           | Token + client capabilities → mode, URL, subtitles                  |
| `POST /api/playback/seek`                                | Move an HLS stream; returns the generation and playlist URL to load |
| `POST /api/playback/stop`                                | End an HLS stream and delete its output (204)                       |
| `GET /api/health`                                        | Status, active streams, hardware acceleration                       |
| `GET, HEAD /media/direct/:fileId?token=`                 | Original file with single byte ranges                               |
| `GET /media/hls/:streamId/:generation/index.m3u8?token=` | VOD playlist of one generation                                      |
| `GET /media/hls/:streamId/:generation/init.mp4?token=`   | fMP4 init segment                                                   |
| `GET /media/hls/:streamId/:generation/:index.m4s?token=` | fMP4 media segment                                                  |
| `GET /media/subtitles/:fileId/:track.vtt?token=`         | WebVTT (`e<stream>` embedded, `x<n>` sidecar)                       |
| `GET /*`                                                 | Built web app from `WEB_DIST_DIR`, with SPA fallback                |

Errors are JSON bodies encoded with their tagged error schema, such as
`{"_tag":"StreamGenerationGone","streamId":"…","generation":1,"currentGeneration":2}` (410).

## Configuration

Required: `MEDIA_BASE_URL`, `DATA_DIR`, `TRANSCODE_DIR`, `PLAYBACK_TOKEN_SECRET` (base64url,
≥ 32 bytes). Optional with defaults: `LIBRARY_ROOTS` (comma list of approved mounts; none
approves nothing, so every scan is refused), `PORT` (4300),
`BACKUP_DIR` (`/data/backups`), `TMDB_API_KEY` (v3 key or v4 read token), `WEB_DIST_DIR`,
`MAX_CONCURRENT_TRANSCODES` (3), `HARDWARE_ACCELERATION` (`auto`, `qsv`, `none`),
`QSV_DEVICE` (`/dev/dri/renderD128`), `STREAM_IDLE_SECONDS` (60), `MIN_FREE_TRANSCODE_MB`
(2048), `LIBRARY_RECONCILE_MINUTES` (360), `FFMPEG_PATH`, `FFPROBE_PATH`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `CONVEX_URL`, `MEDIA_SERVICE_API_KEY`.

QSV needs an ffmpeg built with libvpl; the Nix dev shell uses `ffmpeg-full` for that.

## Integration seams

The Convex integration provides these services (`Context.Service` tags):

- `LibrarySink` (`src/library/library-sink.ts`): `previousIndex`, `upsertBatch` (≤ 100
  records), `markMissing`, `reportProgress`.
- `FileResolver` (`src/playback/file-resolver.ts`): `resolve(fileId)` → path, size, mtime,
  probe, and sidecar subtitles. Paths are re-checked against `LIBRARY_ROOTS`.
- `PlaybackReporter` (`src/playback/playback-reporter.ts`): `report(event)` for `ModeChosen`,
  `ModeChanged` (QSV → software), and `StreamEnded`.
- `PlaybackToken.Service` is local for now; swap in the shared verifier from contracts later.

## Effect unstable modules

Effect 4.0.3 marks its HTTP, platform, process, observability, and some core modules
`@stability unstable`, and the lint preset rejects unstable APIs. `tsconfig.json` allows exactly
the modules this service depends on (`allowedUnstableApis`): the architecture chose Effect
HttpApi and the lint rules require Effect's `FileSystem` and `ChildProcessSpawner`.
