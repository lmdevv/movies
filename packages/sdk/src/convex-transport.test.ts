import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { translateFailure } from "./convex-transport";

describe("translateFailure", () => {
  it("turns ConvexError data into the command error for its code", () => {
    const error = translateFailure(
      "rooms:play",
      new ConvexError({ code: "stale_revision", message: "The room changed" }),
    );

    expect(error).toMatchObject({ _tag: "StaleRevision", message: "The room changed" });
  });

  it("reports ConvexError data without a known code as a protocol error", () => {
    expect(translateFailure("x:y", new ConvexError({ code: "nope", message: "?" }))).toMatchObject({
      _tag: "ProtocolError",
    });
  });

  it("treats Convex rejecting the token as a signed-out session", () => {
    const rejected = new Error(
      JSON.stringify({ code: "Unauthenticated", message: "Could not verify OIDC token claim" }),
    );

    expect(translateFailure("account:viewer", rejected)).toMatchObject({ _tag: "Unauthenticated" });
  });

  it("separates crashed functions from network failures", () => {
    expect(translateFailure("x:y", new Error("[Request ID: 1] Server Error"))).toMatchObject({
      _tag: "Internal",
    });
    expect(translateFailure("x:y", new TypeError("fetch failed"))).toMatchObject({
      _tag: "TransportError",
    });
  });
});
