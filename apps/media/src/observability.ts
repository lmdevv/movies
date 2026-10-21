/**
 * Structured JSON logs on standard output and in the retained log files (`logging/retained-logs.ts`),
 * at `LOG_LEVEL` and above, plus OTLP traces and logs when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * Nothing here should ever see a token or secret: request logs carry paths without query strings,
 * tool errors scrub absolute paths, and configuration secrets stay `Redacted`. As a last line of
 * defense every log line and every OTLP export is redacted on the way out: fields named like
 * credentials, and values shaped like tokens, API keys, admin keys, and credential query
 * parameters. Exports matter as much as logs: HTTP spans record `url.full` and `url.query`, which
 * carry playback tokens.
 */
import { Effect, Formatter, Layer, Logger, Option, Predicate, References, Schema } from "effect";
import { FetchHttpClient, HttpBody } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

import * as RetainedLogs from "./logging/retained-logs.ts";
import * as MediaConfig from "./media-config.ts";

const resource = { serviceName: "movies-media" };

const REDACTED = "<redacted>";

/** Field names whose values are always replaced, at any depth: names ending in a credential. */
const SECRET_FIELD =
  /(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credentials?)$/i;

/** Value shapes replaced inside any logged or exported string. */
const SECRET_VALUES: ReadonlyArray<readonly [RegExp, string]> = [
  // Credential query parameters and assignments, as in `?token=…` or `X-Plex-Token=…`.
  [
    /\b((?:access_|x-plex-|x-emby-)?token|api_?key|key|secret|password)=[^\s&"',;\\]+/gi,
    `$1=${REDACTED}`,
  ],
  // Quoted credential fields inside text, as in `import failed: {"password":"…"}`.
  [
    /(["']?)\b([\w.-]*?(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credentials?))\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi,
    `$1$2$1$3$4${REDACTED}$4`,
  ],
  // `Authorization` schemes, and Jellyfin's `Token="…"` parameter.
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\bToken="[^"]*"/g, `Token="${REDACTED}"`],
  // Signed tokens with a base64url JSON header: JWTs and playback tokens.
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, REDACTED],
  // [movies] API keys and the media service key.
  [/\bmk_[\w-]{16,}/g, REDACTED],
  // Convex admin keys: `<instance>|<hex>`.
  [/\b[\w-]+\|[0-9a-f]{32,}\b/g, REDACTED],
];

const redactText = (text: string): string =>
  SECRET_VALUES.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    text,
  );

const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value);

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Json));

/**
 * `value` with credential fields and token-shaped strings replaced, at any depth, including JSON
 * serialized into a string (OTLP flattens objects and log messages that way). OTLP attributes are
 * `{ key, value }` pairs, so a pair whose `key` names a credential loses its value too.
 */
const redactJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return redactString(value);

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return value;

  if (isJsonArray(value)) return value.map(redactJson);

  const attributeKey = value["key"];
  const secretAttribute = Predicate.isString(attributeKey) && SECRET_FIELD.test(attributeKey);

  return Object.fromEntries(
    Object.entries(value).map(([key, field]): [string, Schema.Json] => {
      if (secretAttribute && key === "value") return [key, { stringValue: REDACTED }];

      return [key, SECRET_FIELD.test(key) ? REDACTED : redactJson(field)];
    }),
  );
};

/** JSON `text` redacted field by field; text that is not JSON is redacted as a whole. */
export const redactJsonText = (text: string): string =>
  Option.match(decodeJson(text), {
    onNone: () => redactText(text),
    onSome: (json) => JSON.stringify(redactJson(json)),
  });

/** A string, redacted field by field when it holds a JSON object or array. */
const redactString = (text: string): string =>
  /^\s*[[{]/.test(text) ? redactJsonText(text) : redactText(text);

const redactedLine = Logger.map(Logger.formatStructured, (structured) =>
  redactJsonText(Formatter.formatJson(structured)),
);

/** The redacted line on standard output and, the same line, in the retained log. */
const teeLogger = (retained: RetainedLogs.Interface) =>
  Logger.withConsoleLog(
    Logger.make((options) => {
      const line = redactedLine.log(options);

      retained.append(line, options.date.getTime());

      return line;
    }),
  );

/** OTLP JSON bodies, redacted after serialization so every span and log attribute is covered. */
const redactedSerialization = Layer.succeed(OtlpSerialization.OtlpSerialization, {
  traces: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
  metrics: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
  logs: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
});

/**
 * Logging, the retained log (whose `RetainedLogs` service the log routes read), and optional
 * telemetry export; provide it to the whole application.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const retained = yield* RetainedLogs.Service;

    const logs = Layer.mergeAll(
      Logger.layer([teeLogger(retained)]),
      Layer.succeed(References.MinimumLogLevel, config.logs.level),
      Layer.succeed(RetainedLogs.Service, retained),
    );

    if (Option.isNone(config.otlpEndpoint)) return logs;
    const endpoint = config.otlpEndpoint.value;

    const telemetry = Layer.mergeAll(
      OtlpTracer.layer({ url: `${endpoint}/v1/traces`, resource }),
      OtlpLogger.layer({ url: `${endpoint}/v1/logs`, resource }),
    ).pipe(Layer.provide(redactedSerialization), Layer.provide(FetchHttpClient.layer));

    return Layer.mergeAll(logs, telemetry);
  }),
).pipe(Layer.provide(RetainedLogs.layer));
