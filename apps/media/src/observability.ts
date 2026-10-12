/**
 * Structured JSON logs, plus OTLP traces and logs when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * Nothing here logs tokens or secrets: request logs carry paths without query strings, tool
 * errors scrub absolute paths, and configuration secrets stay `Redacted`.
 */
import { Effect, Layer, Logger, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

import * as MediaConfig from "./media-config.ts";

const resource = { serviceName: "movies-media" };

/** Logging and optional telemetry export; provide it to the whole application. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const logs = Logger.layer([Logger.consoleJson]);

    if (Option.isNone(config.otlpEndpoint)) return logs;
    const endpoint = config.otlpEndpoint.value;

    const telemetry = Layer.mergeAll(
      OtlpTracer.layer({ url: `${endpoint}/v1/traces`, resource }),
      OtlpLogger.layer({ url: `${endpoint}/v1/logs`, resource }),
    ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

    return Layer.mergeAll(logs, telemetry);
  }),
);
