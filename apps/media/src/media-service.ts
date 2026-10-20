/**
 * Composition of the media service's capabilities. The result still requires the integration
 * seams (`LibrarySink`, `FileResolver`, `PlaybackReporter`) plus configuration and platform
 * services, so the Convex integration can provide its own implementations; standalone mode and
 * tests provide the in-memory and logging ones.
 */
import { Layer } from "effect";

import * as ArtworkKeys from "./artwork/artwork-keys.ts";
import * as ArtworkStore from "./artwork/artwork-store.ts";
import * as DiskCache from "./disk-cache.ts";
import * as Downloads from "./downloads/downloads.ts";
import * as LibraryScanner from "./library/library-scanner.ts";
import * as MediaTools from "./media/media-tools.ts";
import * as MetadataResolver from "./metadata/title-metadata.ts";
import * as Omdb from "./metadata/omdb.ts";
import * as Tmdb from "./metadata/tmdb.ts";
import * as HardwareAcceleration from "./playback/hardware-acceleration.ts";
import * as KeyframeIndex from "./playback/keyframe-index.ts";
import * as EndedSessions from "./playback/ended-sessions.ts";
import * as PlaybackNegotiator from "./playback/playback-negotiator.ts";
import * as PlaybackToken from "./playback/playback-token.ts";
import * as StreamSessions from "./playback/stream-sessions.ts";
import * as TranscodeSpace from "./playback/transcode-space.ts";
import * as SubtitleConverter from "./subtitles/subtitle-tracks.ts";
import * as TrickplayStore from "./trickplay/trickplay-store.ts";

/** Scanning, metadata, negotiation, streaming, downloads, and subtitles over the integration seams. */
export const servicesLayer = Layer.mergeAll(
  PlaybackNegotiator.layer,
  Downloads.layer,
  LibraryScanner.layer,
  SubtitleConverter.layer,
).pipe(
  Layer.provideMerge(StreamSessions.layer),
  Layer.provideMerge(TranscodeSpace.layer),
  Layer.provideMerge(KeyframeIndex.layer),
  Layer.provideMerge(HardwareAcceleration.layer),
  Layer.provideMerge(MetadataResolver.layer),
  Layer.provideMerge(ArtworkStore.layer),
  Layer.provideMerge(ArtworkKeys.layer),
  Layer.provideMerge(Tmdb.layer),
  Layer.provideMerge(Omdb.layer),
  Layer.provideMerge(PlaybackToken.layer),
  Layer.provideMerge(EndedSessions.layer),
  Layer.provideMerge(DiskCache.layer),
  Layer.provideMerge(TrickplayStore.layer),
  Layer.provideMerge(MediaTools.layer),
);
