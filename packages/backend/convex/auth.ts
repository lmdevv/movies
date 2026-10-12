/**
 * Convex Auth with three providers:
 *
 * - `password`: email and password. The first account becomes the owner; later sign-ups need an
 *   invite. Sessions hold every scope the role allows.
 * - `apikey`: `{ key }`. All sign-ins with one key share one session, bound to the key's scopes;
 *   revoking the key deletes that session. The media service signs in this way.
 * - `device`: `{ deviceCode }`. Consumes an approved device code once and binds a new session to
 *   the scopes chosen at approval.
 *
 * Sign-in params arrive untyped from the client. Each provider passes them to an internal function
 * whose `v` validator parses them, so no provider trusts their shape.
 */
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";
import { Scrypt } from "lucia";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";

/** Sign-in params as the client sent them. */
type SignInParams = Partial<Record<string, Value | undefined>>;

/** Password params after `authParams:password` validated them. */
interface PasswordParams {
  readonly flow: "signUp" | "signIn";
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly inviteCode?: string;
}

/** What a password sign-up hands to `createOrUpdateUser`; a type alias, so it is a Convex `Value`. */
type SignUpProfile = {
  email: string;
  role: "member";
  name?: string;
  inviteCode?: string;
};

/** A sign-in the redeem mutations allow: the account and the session it joins. */
interface Redeemed {
  readonly userId: Id<"users">;
  readonly sessionId: Id<"authSessions">;
}

// These references take raw params on purpose: the target functions' validators parse them.
const parsePasswordParams = makeFunctionReference<"query", SignInParams, PasswordParams>(
  "authParams:password",
);

const redeemApiKey = makeFunctionReference<"mutation", SignInParams, Redeemed | null>(
  "apiKeys:redeem",
);

const redeemDeviceCode = makeFunctionReference<"mutation", SignInParams, Redeemed | null>(
  "deviceAuth:redeem",
);

/** The profile Convex Auth hands to `createOrUpdateUser`, untyped beyond its email. */
type CallbackProfile = Parameters<
  NonNullable<NonNullable<ConvexAuthConfig["callbacks"]>["createOrUpdateUser"]>
>[1]["profile"];

const createUserFromSignUp = makeFunctionReference<"mutation", CallbackProfile, Id<"users">>(
  "users:createFromSignUp",
);

const MIN_PASSWORD_LENGTH = 8;

const scrypt = new Scrypt();

/**
 * The profile `createOrUpdateUser` receives. Its role is a placeholder: `users:createFromSignUp`
 * makes the first account the owner and gives later ones their invite's role.
 */
const signUpProfile = (email: string, parsed: PasswordParams): SignUpProfile => {
  const profile: SignUpProfile = { email, role: "member" };

  if (parsed.name !== undefined) profile.name = parsed.name;

  if (parsed.inviteCode !== undefined) profile.inviteCode = parsed.inviteCode;

  return profile;
};

const signInFailure = (cause: unknown): never => {
  const reason = cause instanceof Error ? cause.message : "";

  if (reason === "TooManyFailedAttempts") {
    return fail("rate_limited", "Too many failed sign-ins; wait a few minutes and try again");
  }

  return fail("unauthenticated", "Wrong email or password");
};

const convexAuthFunctions = convexAuth({
  providers: [
    ConvexCredentials({
      id: "password",
      authorize: async (params, ctx) => {
        const parsed = await ctx.runQuery(parsePasswordParams, params);
        const email = parsed.email.trim().toLowerCase();

        if (parsed.flow === "signIn") {
          const retrieved = await retrieveAccount(ctx, {
            provider: "password",
            account: { id: email, secret: parsed.password },
          }).catch(signInFailure);

          return { userId: retrieved.user._id };
        }

        if (parsed.password.length < MIN_PASSWORD_LENGTH) {
          return fail("invalid_args", "Use at least 8 characters for the password");
        }

        const { user } = await createAccount(ctx, {
          provider: "password",
          account: { id: email, secret: parsed.password },
          profile: signUpProfile(email, parsed),
          shouldLinkViaEmail: false,
          shouldLinkViaPhone: false,
        });

        return { userId: user._id };
      },
      crypto: {
        hashSecret: (password) => scrypt.hash(password),
        verifySecret: (password, hash) => scrypt.verify(hash, password),
      },
    }),
    ConvexCredentials({
      id: "apikey",
      authorize: (params, ctx) => ctx.runMutation(redeemApiKey, params),
    }),
    ConvexCredentials({
      id: "device",
      authorize: (params, ctx) => ctx.runMutation(redeemDeviceCode, params),
    }),
  ],
  callbacks: {
    createOrUpdateUser: async (ctx, args) => {
      if (args.existingUserId !== null) return args.existingUserId;

      return ctx.runMutation(createUserFromSignUp, args.profile);
    },
    beforeSessionCreation: async (ctx, { userId }) => {
      await ctx.runQuery(internal.users.assertCanSignIn, { userId });
    },
  },
});

export const { auth, signIn, store, isAuthenticated } = convexAuthFunctions;

/**
 * Signs out as Convex Auth's own `signOut` does (the session and its refresh tokens go), and also
 * ends the playback sessions it started, so the media service stops their streams at once instead
 * of when the idle sweep notices.
 */
export const signOut = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.sessions.endCurrent, {});

    return null;
  },
});
