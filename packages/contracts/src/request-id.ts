import { Schema } from "effect";

/** The response header that carries the request id. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The media service's id for one request: a version 4 UUID it generates, never the caller's, and
 * sends back on every response, failures included. Every log line written while serving the
 * request carries it as `requestId`. Clients drop an id in any other shape, such as a proxy's.
 */
export const RequestId = Schema.String.check(Schema.isUUID(4));
