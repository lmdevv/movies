import { Schema } from "effect";

import { ApiKeyId, AuthSessionId, InviteId, LibraryId, UserId } from "../ids";
import {
  ApiKey,
  CreatedApiKey,
  CreatedInvite,
  DeviceCodeLookup,
  DeviceCodeRequest,
  DeviceCodeState,
  DeviceScopes,
  Invite,
  InviteLookup,
  NewPassword,
  SessionInfo,
  SetupStatus,
  User,
  Viewer,
} from "../models/account";
import { DisplayName, NoArgs, Ok } from "../models/common";
import { ApiKeyScope, AssignableRole } from "../scopes";
import { action, mutation, query } from "./command";

const Code = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Setup and the signed-in viewer. */
export const accountCommands = {
  "setup.status": query({
    summary: "Show whether the server has an owner and a library yet",
    group: "setup",
    scope: "public",
    args: NoArgs,
    result: SetupStatus,
    function: "setup:status",
  }),
  "account.viewer": query({
    summary: "Show the signed-in account and what this session may do",
    group: "account",
    scope: "authenticated",
    args: NoArgs,
    result: Viewer,
    function: "account:viewer",
  }),
  "account.changePassword": action({
    summary: "Change the account's password after checking the current one",
    group: "account",
    scope: "account",
    args: Schema.Struct({ currentPassword: Schema.String, newPassword: NewPassword }),
    result: Ok,
    function: "account:changePassword",
  }),
};

/** Invites and account administration. */
export const userCommands = {
  "invites.lookup": query({
    summary: "Show an invite's state from its code",
    group: "invites",
    scope: "public",
    args: Schema.Struct({ code: Code }),
    result: InviteLookup,
    function: "invites:lookup",
  }),
  "invites.create": action({
    summary: "Invite someone to create an account",
    group: "invites",
    scope: "admin",
    args: Schema.Struct({
      email: Schema.optionalKey(Schema.Trimmed.check(Schema.isMinLength(3))),
      role: AssignableRole,
      expiresInDays: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
      ),
    }),
    result: CreatedInvite,
    function: "invites:create",
  }),
  "invites.list": query({
    summary: "List invites",
    group: "invites",
    scope: "admin",
    args: NoArgs,
    result: Schema.Array(Invite),
    function: "invites:list",
  }),
  "invites.revoke": mutation({
    summary: "Revoke an open invite",
    group: "invites",
    scope: "admin",
    args: Schema.Struct({ inviteId: InviteId }),
    result: Ok,
    function: "invites:revoke",
  }),
  "users.list": query({
    summary: "List accounts",
    group: "users",
    scope: "admin",
    args: NoArgs,
    result: Schema.Array(User),
    function: "users:list",
  }),
  "users.setRole": mutation({
    summary: "Make an account an admin or a member",
    group: "users",
    scope: "admin",
    args: Schema.Struct({ userId: UserId, role: AssignableRole }),
    result: Ok,
    function: "users:setRole",
  }),
  "users.disable": mutation({
    summary: "Disable an account and sign out all of its sessions",
    group: "users",
    scope: "admin",
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
    function: "users:disable",
  }),
  "users.enable": mutation({
    summary: "Re-enable a disabled account",
    group: "users",
    scope: "admin",
    args: Schema.Struct({ userId: UserId }),
    result: Ok,
    function: "users:enable",
  }),
  "users.setLibraryAccess": mutation({
    summary: "Choose which restricted libraries a member can see",
    group: "users",
    scope: "admin",
    args: Schema.Struct({ userId: UserId, libraryIds: Schema.Array(LibraryId) }),
    result: Ok,
    function: "users:setLibraryAccess",
  }),
};

/** API keys, device sign-in, and signed-in sessions. */
export const credentialCommands = {
  "apiKeys.create": action({
    summary: "Create a scoped API key; the secret is shown once",
    group: "keys",
    scope: "account",
    args: Schema.Struct({
      name: DisplayName,
      scopes: Schema.Array(ApiKeyScope).check(Schema.isMinLength(1)),
      expiresInDays: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
      ),
    }),
    result: CreatedApiKey,
    function: "apiKeys:create",
  }),
  "apiKeys.list": query({
    summary: "List API keys; admins may list another account's",
    group: "keys",
    scope: "account",
    args: Schema.Struct({ userId: Schema.optionalKey(UserId) }),
    result: Schema.Array(ApiKey),
    function: "apiKeys:list",
  }),
  "apiKeys.revoke": mutation({
    summary: "Revoke an API key and end every session it signed in",
    group: "keys",
    scope: "account",
    args: Schema.Struct({ apiKeyId: ApiKeyId }),
    result: Ok,
    function: "apiKeys:revoke",
  }),
  "deviceAuth.request": action({
    summary: "Start a device sign-in and get a code to approve",
    group: "devices",
    scope: "public",
    args: Schema.Struct({ clientName: DisplayName }),
    result: DeviceCodeRequest,
    function: "deviceAuth:request",
  }),
  "deviceAuth.status": query({
    summary: "Watch whether a device sign-in was approved",
    group: "devices",
    scope: "public",
    args: Schema.Struct({ deviceCode: Code }),
    result: Schema.Struct({ state: DeviceCodeState }),
    function: "deviceAuth:status",
  }),
  "deviceAuth.lookup": query({
    summary: "Show the device behind a sign-in code",
    group: "devices",
    scope: "account",
    args: Schema.Struct({ userCode: Code }),
    result: DeviceCodeLookup,
    function: "deviceAuth:lookup",
  }),
  "deviceAuth.approve": mutation({
    summary: "Approve a device sign-in with chosen scopes",
    group: "devices",
    scope: "account",
    args: Schema.Struct({ userCode: Code, scopes: DeviceScopes }),
    result: Ok,
    function: "deviceAuth:approve",
  }),
  "deviceAuth.deny": mutation({
    summary: "Deny a device sign-in",
    group: "devices",
    scope: "account",
    args: Schema.Struct({ userCode: Code }),
    result: Ok,
    function: "deviceAuth:deny",
  }),
  "sessions.list": query({
    summary: "List signed-in browsers, devices, and API keys",
    group: "sessions",
    scope: "account",
    args: NoArgs,
    result: Schema.Array(SessionInfo),
    function: "sessions:list",
  }),
  "sessions.revoke": mutation({
    summary: "Sign out a session",
    group: "sessions",
    scope: "account",
    args: Schema.Struct({ sessionId: AuthSessionId }),
    result: Ok,
    function: "sessions:revoke",
  }),
};
