import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CommandFailure,
  commandError,
  Conflict,
  Expired,
  Forbidden,
  Internal,
  InvalidArgs,
  NotFound,
  RateLimited,
  StaleRevision,
  Unauthenticated,
} from "./errors";
import type { ErrorCode } from "./errors";

const decodeFailure = Schema.decodeUnknownSync(CommandFailure);

const message = "Sign in first";

const expected: ReadonlyArray<readonly [ErrorCode, unknown]> = [
  ["unauthenticated", new Unauthenticated({ message })],
  ["forbidden", new Forbidden({ message })],
  ["not_found", new NotFound({ message })],
  ["invalid_args", new InvalidArgs({ message })],
  ["conflict", new Conflict({ message })],
  ["expired", new Expired({ message })],
  ["stale_revision", new StaleRevision({ message })],
  ["rate_limited", new RateLimited({ message })],
  ["internal", new Internal({ message })],
];

describe("commandError", () => {
  it.each(expected)("turns %s into its tagged error", (code, error) => {
    expect(commandError(decodeFailure({ code, message }))).toStrictEqual(error);
  });

  it("rejects unknown codes at the wire boundary", () => {
    expect(() => decodeFailure({ code: "teapot", message: "no" })).toThrow();
  });
});
