import { Schema } from "effect";

import { DiagnosedSession, PlaybackDiagnostics } from "../diagnostics";
import { PlaybackSessionId } from "../ids";
import { EpochMillis } from "../units";
import { media } from "./command";

/** Diagnostics commands. */
export const diagnosticsCommands = {
  "diagnostics.playback": media({
    summary:
      "Build the timeline of a playback session from the retained logs: streams, slow and failed segments, stalls, player errors, and recoveries",
    group: "diagnostics",
    scope: "read",
    args: Schema.Struct({
      sessionId: PlaybackSessionId,
      /**
       * The caller decodes a measured `drift`. Without it a measured drift comes back as
       * `not-measured` with the numbers in its reason, which clients before it can decode.
       */
      measuredDrift: Schema.optionalKey(Schema.Boolean),
    }),
    result: PlaybackDiagnostics,
    route: { method: "POST", path: "/api/diagnostics/playback" },
  }),
  "diagnostics.sessions": media({
    summary: "List playback sessions the retained logs mention, newest first",
    group: "diagnostics",
    scope: "read",
    args: Schema.Struct({
      /** Sessions seen at or after this instant; the last day when omitted. */
      since: Schema.optionalKey(EpochMillis),
    }),
    result: Schema.Array(DiagnosedSession),
    route: { method: "POST", path: "/api/diagnostics/sessions" },
  }),
};
