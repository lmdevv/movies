import { query } from "./_generated/server";
import { presentUser } from "./lib/present";
import { viewer as viewerResult } from "./lib/validators";
import { authorize } from "./lib/viewer";

/**
 * The signed-in account and its session's scopes. The media service calls this with a user's
 * token to authorize `media` commands.
 */
export const viewer = query({
  args: {},
  returns: viewerResult,
  handler: async (ctx) => {
    const current = await authorize(ctx, "authenticated");

    return {
      user: presentUser(current.user),
      sessionId: current.session._id,
      sessionKind: current.session.grant?.kind ?? ("password" as const),
      scopes: [...current.scopes],
    };
  },
});
