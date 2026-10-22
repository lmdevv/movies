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
