/**
 * Failures the SDK adds to the command errors in `@movies/contracts/errors`: the server could not
 * be reached, or it answered with something the contracts do not describe.
 */
import type { CommandError } from "@movies/contracts/errors";
import { Schema } from "effect";

/**
 * The server could not be reached or the connection dropped before an answer arrived. A mutation
 * that fails this way may still have run; read the state again before retrying it.
 */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  /** The command or function that was running, such as `titles.list`. */
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The server answered with a value the contracts do not describe. This points at mismatched
 * client and server versions or a server bug; retrying does not help.
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Any failure a command call can end with. */
export type CallError = CommandError | TransportError | ProtocolError;
