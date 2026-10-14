/** Accounts, sessions, invites, API keys, and device sign-in. */
import { Schema } from "effect";

import { ApiKeyId, AuthSessionId, InviteId, UserId } from "../ids";
import { ApiKeyScope, AssignableRole, DeviceScope, Role, Scope } from "../scopes";
import { EpochMillis } from "../units";

/** An account as other people and admins see it. */
export const User = Schema.Struct({
  id: UserId,
  email: Schema.NullOr(Schema.String),
  name: Schema.String,
  role: Role,
  disabled: Schema.Boolean,
  createdAt: EpochMillis,
});

/** An account. */
export interface User extends Schema.Schema.Type<typeof User> {}

/** How a session signed in. `password` sessions hold every scope their role allows. */
export const SessionKind = Schema.Literals(["password", "apikey", "device"]);

/** How a session signed in. */
export type SessionKind = typeof SessionKind.Type;

/** The signed-in account and what the current session may do. */
export const Viewer = Schema.Struct({
  user: User,
  sessionId: AuthSessionId,
  sessionKind: SessionKind,
  scopes: Schema.Array(Scope),
});

/** The signed-in account and its session scopes. */
export interface Viewer extends Schema.Schema.Type<typeof Viewer> {}

/** A signed-in browser, CLI, TV, or API key, as listed under the account's sessions. */
export const SessionInfo = Schema.Struct({
  id: AuthSessionId,
  kind: SessionKind,
  /** The key name or the device's client name; null for password sessions. */
  label: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Scope),
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
  current: Schema.Boolean,
});

/** A signed-in session. */
export interface SessionInfo extends Schema.Schema.Type<typeof SessionInfo> {}

/** First-run state for the welcome screen. */
export const SetupStatus = Schema.Struct({
  hasOwner: Schema.Boolean,
  hasLibraries: Schema.Boolean,
});

/** First-run state. */
export interface SetupStatus extends Schema.Schema.Type<typeof SetupStatus> {}

/** Lifecycle of an invite. */
export const InviteState = Schema.Literals(["open", "used", "expired", "revoked"]);

/** Lifecycle of an invite. */
export type InviteState = typeof InviteState.Type;

/** An invite as admins see it. The code itself is shown only once, when it is created. */
export const Invite = Schema.Struct({
  id: InviteId,
  email: Schema.NullOr(Schema.String),
  role: AssignableRole,
  state: InviteState,
  createdBy: UserId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
});

/** An invite. */
export interface Invite extends Schema.Schema.Type<typeof Invite> {}

/** A newly created invite with its secret code and the accept link built from `SITE_URL`. */
export const CreatedInvite = Schema.Struct({
  invite: Invite,
  code: Schema.String,
  url: Schema.String,
});

/** A newly created invite. */
export interface CreatedInvite extends Schema.Schema.Type<typeof CreatedInvite> {}

/** What the accept-invite screen shows to someone holding a code. */
export const InviteLookup = Schema.Union([
  Schema.Struct({ state: Schema.Literal("invalid") }),
  Schema.Struct({
    state: InviteState.pick(["open", "used", "expired"]),
    email: Schema.NullOr(Schema.String),
    inviterName: Schema.String,
    expiresAt: EpochMillis,
  }),
]);

/** What the accept-invite screen shows. */
export type InviteLookup = typeof InviteLookup.Type;

/** An API key as its owner sees it. */
export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  userId: UserId,
  name: Schema.String,
  /** The first characters of the key, enough to recognize it. */
  prefix: Schema.String,
  scopes: Schema.Array(ApiKeyScope),
  createdAt: EpochMillis,
  lastUsedAt: Schema.NullOr(EpochMillis),
  expiresAt: Schema.NullOr(EpochMillis),
  revokedAt: Schema.NullOr(EpochMillis),
});

/** An API key. */
export interface ApiKey extends Schema.Schema.Type<typeof ApiKey> {}

/** A newly created API key and its secret, shown once. Sign in with provider `apikey` and `{ key }`. */
export const CreatedApiKey = Schema.Struct({
  apiKey: ApiKey,
  secret: Schema.String,
});

/** A newly created API key and its secret. */
export interface CreatedApiKey extends Schema.Schema.Type<typeof CreatedApiKey> {}

/**
 * A pending device sign-in. The device keeps `deviceCode` secret, shows `userCode` and a QR code of
 * `verificationUrl`, watches `deviceAuth.status`, and signs in with provider `device` once approved.
 */
export const DeviceCodeRequest = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresAt: EpochMillis,
});

/** A pending device sign-in. */
export interface DeviceCodeRequest extends Schema.Schema.Type<typeof DeviceCodeRequest> {}

/** Where a device sign-in stands. `consumed` means the device already signed in with it. */
export const DeviceCodeState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
]);

/** Where a device sign-in stands. */
export type DeviceCodeState = typeof DeviceCodeState.Type;

/** What the approve-device screen shows for a user code. */
export const DeviceCodeLookup = Schema.Struct({
  userCode: Schema.String,
  clientName: Schema.String,
  state: DeviceCodeState,
  requestedAt: EpochMillis,
  expiresAt: EpochMillis,
});

/** What the approve-device screen shows. */
export interface DeviceCodeLookup extends Schema.Schema.Type<typeof DeviceCodeLookup> {}

/** Scopes granted to an approved device. */
export const DeviceScopes = Schema.Array(DeviceScope).check(Schema.isMinLength(1));
