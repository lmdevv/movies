/**
 * What the owner does outside the browser in the stack suite: create invites through the SDK's
 * Promise facade, the way any other client would.
 */
import type { CreatedInvite } from "@movies/contracts/models/account";
import { createMovies } from "@movies/sdk/promise";

import type { StackEnv } from "./stack-env";

/** A member invite and the id of the owner who made it. */
export interface OwnerInvite {
  readonly invite: CreatedInvite;
  readonly ownerId: string;
}

/** Signs in as the owner and creates a member invite. */
export const createInvite = async (
  stack: StackEnv,
  owner: { readonly email: string; readonly password: string },
): Promise<OwnerInvite> => {
  const movies = createMovies({ convexUrl: stack.convexUrl, connection: "http" });

  try {
    await movies.auth.signInWithPassword({
      flow: "signIn",
      email: owner.email,
      password: owner.password,
    });

    const viewer = await movies.query("account.viewer", {});
    const invite = await movies.action("invites.create", { role: "member" });

    return { invite, ownerId: viewer.user.id };
  } finally {
    await movies.dispose();
  }
};
