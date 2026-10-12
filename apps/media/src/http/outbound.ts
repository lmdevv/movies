/**
 * The HTTP client the service sends its own requests with: TMDB metadata and images, and
 * migration sources. It never follows redirects. Those requests are allowed by host (only
 * `image.tmdb.org` for artwork, only the source server for a migration); a redirect would lead
 * them to another host, carrying a Plex token or Jellyfin key along. A redirect arrives as an
 * unsuccessful response instead, which each caller already treats as a failure.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const MANUAL_REDIRECTS: RequestInit = { redirect: "manual" };

/** `FetchHttpClient` with redirects left to the caller. */
export const layer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return HttpClient.transform(client, (effect) =>
      Effect.provideService(effect, FetchHttpClient.RequestInit, MANUAL_REDIRECTS),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
