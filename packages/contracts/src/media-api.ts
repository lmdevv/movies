/**
 * The media service's Effect HttpApi: playback negotiation, HLS stream control, health, and the
 * connection details apps read. The
 * media service implements it; clients that may use Effect's unstable HTTP modules can derive an
 * `HttpApiClient` from it, and others decode the same schemas from `@movies/contracts/media-playback`.
 *
 * Media bytes (direct files, HLS playlists and segments, WebVTT, artwork) are plain routes on the
 * media service, because `<video>`, `<img>`, and HLS players fetch them by URL. Registry `media`
 * commands (such as `metadata.searchCandidates`) answer with command failures instead and are
 * described by `@movies/contracts/commands`.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import {
  ClientConfigResponse,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateErrors,
  NegotiateRequest,
  NegotiateResponse,
  SeekErrors,
  SeekRequest,
  SeekResponse,
  StopErrors,
  StopRequest,
} from "./media-playback";

/** Playback negotiation and HLS stream control. */
export class PlaybackGroup extends HttpApiGroup.make("playback").add(
  HttpApiEndpoint.post("negotiate", MEDIA_ROUTES.negotiate, {
    payload: NegotiateRequest,
    success: NegotiateResponse,
    error: NegotiateErrors,
  }),
  HttpApiEndpoint.post("seek", MEDIA_ROUTES.seek, {
    payload: SeekRequest,
    success: SeekResponse,
    error: SeekErrors,
  }),
  HttpApiEndpoint.post("stop", MEDIA_ROUTES.stop, {
    payload: StopRequest,
    success: HttpApiSchema.NoContent,
    error: StopErrors,
  }),
) {}

/** Liveness and capability summary, and how apps find the Convex deployment. */
export class SystemGroup extends HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", MEDIA_ROUTES.health, { success: HealthResponse }),
  HttpApiEndpoint.get("clientConfig", MEDIA_ROUTES.clientConfig, { success: ClientConfigResponse }),
) {}

/** The media service API. */
export class MediaApi extends HttpApi.make("media").add(PlaybackGroup).add(SystemGroup) {}
