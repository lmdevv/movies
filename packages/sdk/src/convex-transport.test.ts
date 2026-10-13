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

  it("reports an argument that is not an ID of its table as not found", () => {
    // As the self-hosted backend words them: a string that is no ID, over HTTP and over the
    // WebSocket, and an ID from another table.
    const overHttp = new Error(
      '[Request ID: 55c324b842b35e1b] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .titleId\nValue: "nope"\nValidator: v.id("titles")\n\n',
    );

    const overWebSocket = new Error(
      '[CONVEX Q(titles:get)] [Request ID: 8d858a8ee2675929] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .profileId\nValue: "nope"\nValidator: v.id("profiles")\n\n\n  Called by client',
    );

    const fromAnotherTable = new Error(
      '[Request ID: af9a287f7de12fe1] Server Error\nArgumentValidationError: Found ID "md72x7j3s82e23sy3q1h1y2r7d8g7jvw" from table `profiles`, which does not match the table name in validator `v.id("titles")`.Path: .titleId\n\n',
    );

    expect(translateFailure("titles:get", overHttp)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", overWebSocket)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
    expect(translateFailure("titles:get", fromAnotherTable)).toMatchObject({
      _tag: "NotFound",
      message: "No such item: nothing has that ID",
    });
  });

  it("keeps other argument failures and crashes internal", () => {
    const badNumber = new Error(
      '[Request ID: 1] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .limit\nValue: "x"\nValidator: v.number()\n\n',
    );

    const crashMentioningIds = new Error(
      '[Request ID: 1] Server Error\nUncaught Error: expected Validator: v.id("titles")',
    );

    expect(translateFailure("x:y", badNumber)).toMatchObject({ _tag: "Internal" });
    expect(translateFailure("x:y", crashMentioningIds)).toMatchObject({ _tag: "Internal" });
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
