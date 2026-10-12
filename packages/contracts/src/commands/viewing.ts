/** Profiles, browsing, history, my list, and playback: everything a viewer does on a profile. */
import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import {
  DeviceId,
  EpisodeId,
  LibraryId,
  MediaFileId,
  PlaybackSessionId,
  ProfileId,
  RoomId,
  TitleId,
} from "../ids";
import {
  ContinueWatchingItem,
  Episode,
  HistoryEntry,
  Home,
  Library,
  TitleCard,
  TitleDetail,
  TitleKind,
  TitleSort,
} from "../models/catalog";
import { Collection } from "../models/collections";
import { DisplayName, NoArgs, Ok, Page, PageArgs } from "../models/common";
import {
  PlaybackSession,
  ProgressEvent,
  ProgressReceipt,
  RenewedToken,
  StartedPlayback,
} from "../models/playback";
import { AvatarKey, CreateProfileArgs, Pin, Profile, UnlockResult } from "../models/profiles";
import { Milliseconds } from "../units";
import { mutation, query } from "./command";

const OnProfile = { profileId: ProfileId };

const TitleOnProfile = Schema.Struct({ ...OnProfile, titleId: TitleId });

const WatchTarget = Schema.Struct({
  ...OnProfile,
  titleId: TitleId,
  /** An episode of the show; omit to mark every episode of a show, or a movie. */
  episodeId: Schema.optionalKey(EpisodeId),
});

/** Profiles and PIN unlock. */
export const profileCommands = {
  "profiles.list": query({
    summary: "List this account's profiles",
    group: "profiles",
    scope: "read",
    args: NoArgs,
    result: Schema.Array(Profile),
    function: "profiles:list",
  }),
  "profiles.create": mutation({
    summary: "Create a profile",
    group: "profiles",
    scope: "account",
    args: CreateProfileArgs,
    result: Profile,
    function: "profiles:create",
  }),
  "profiles.update": mutation({
    summary: "Rename a profile or change its avatar or rating limit",
    group: "profiles",
    scope: "account",
    args: Schema.Struct({
      ...OnProfile,
      name: Schema.optionalKey(DisplayName),
      avatar: Schema.optionalKey(AvatarKey),
      kids: Schema.optionalKey(Schema.Boolean),
      maxAgeRating: Schema.optionalKey(Schema.NullOr(AgeRating)),
    }),
    result: Profile,
    function: "profiles:update",
  }),
  "profiles.remove": mutation({
    summary: "Delete a profile with its history and list",
    group: "profiles",
    scope: "account",
    args: Schema.Struct(OnProfile),
    result: Ok,
    function: "profiles:remove",
  }),
  "profiles.setPin": mutation({
    summary: "Set or clear a profile PIN",
    group: "profiles",
    scope: "account",
    args: Schema.Struct({ ...OnProfile, pin: Schema.NullOr(Pin) }),
    result: Ok,
    function: "profiles:setPin",
  }),
  "profiles.unlock": mutation({
    summary: "Unlock a PIN profile for this session",
    group: "profiles",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, pin: Schema.String }),
    result: UnlockResult,
    function: "profiles:unlock",
  }),
  "profiles.lock": mutation({
    summary: "Lock a PIN profile again on this session",
    group: "profiles",
    scope: "read",
    args: Schema.Struct(OnProfile),
    result: Ok,
    function: "profiles:lock",
  }),
};

/** Browsing and searching titles. */
export const browseCommands = {
  "titles.home": query({
    summary: "Show the home rows for a profile",
    group: "browse",
    scope: "read",
    args: Schema.Struct(OnProfile),
    result: Home,
    function: "titles:home",
  }),
  "titles.list": query({
    summary: "List movies or shows",
    group: "browse",
    scope: "read",
    args: Schema.Struct({
      ...OnProfile,
      ...PageArgs,
      kind: Schema.optionalKey(TitleKind),
      libraryId: Schema.optionalKey(LibraryId),
      sort: Schema.optionalKey(TitleSort),
    }),
    result: Page(TitleCard),
    function: "titles:list",
  }),
  "titles.search": query({
    summary: "Search titles by name",
    group: "browse",
    scope: "read",
    args: Schema.Struct({
      ...OnProfile,
      query: Schema.String.check(Schema.isMaxLength(200)),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    }),
    result: Schema.Array(TitleCard),
    function: "titles:search",
  }),
  "titles.get": query({
    summary: "Show a movie or show",
    group: "browse",
    scope: "read",
    args: TitleOnProfile,
    result: TitleDetail,
    function: "titles:get",
  }),
  "titles.episodes": query({
    summary: "List a season's episodes",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, titleId: TitleId, seasonNumber: Schema.Int }),
    result: Schema.Array(Episode),
    function: "titles:episodes",
  }),
  "libraries.list": query({
    summary: "List the libraries this account can see",
    group: "browse",
    scope: "read",
    args: NoArgs,
    result: Schema.Array(Library),
    function: "libraries:list",
  }),
  "collections.list": query({
    summary: "Show collections and the titles a profile may see in each",
    group: "browse",
    scope: "read",
    args: Schema.Struct(OnProfile),
    result: Schema.Array(Collection),
    function: "collections:list",
  }),
};

/** Continue watching, history, watched marks, and my list. */
export const historyCommands = {
  "history.continueWatching": query({
    summary: "List what to resume and which episodes come next",
    group: "history",
    scope: "read",
    args: Schema.Struct(OnProfile),
    result: Schema.Array(ContinueWatchingItem),
    function: "history:continueWatching",
  }),
  "history.list": query({
    summary: "List a profile's watch history, most recent first",
    group: "history",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, ...PageArgs }),
    result: Page(HistoryEntry),
    function: "history:list",
  }),
  "history.markWatched": mutation({
    summary: "Mark a movie, episode, or whole show watched",
    group: "history",
    scope: "play",
    args: WatchTarget,
    result: Ok,
    function: "history:markWatched",
  }),
  "history.markUnwatched": mutation({
    summary: "Mark a movie, episode, or whole show unwatched",
    group: "history",
    scope: "play",
    args: WatchTarget,
    result: Ok,
    function: "history:markUnwatched",
  }),
  "myList.list": query({
    summary: "Show a profile's list",
    group: "history",
    scope: "read",
    args: Schema.Struct(OnProfile),
    result: Schema.Array(TitleCard),
    function: "myList:list",
  }),
  "myList.add": mutation({
    summary: "Add a title to my list",
    group: "history",
    scope: "play",
    args: TitleOnProfile,
    result: Ok,
    function: "myList:add",
  }),
  "myList.remove": mutation({
    summary: "Remove a title from my list",
    group: "history",
    scope: "play",
    args: TitleOnProfile,
    result: Ok,
    function: "myList:remove",
  }),
};

/** Per-device playback sessions and progress. */
export const playbackCommands = {
  "playback.createSession": mutation({
    summary: "Start playing a movie or episode on this device",
    group: "playback",
    scope: "play",
    args: Schema.Struct({
      ...OnProfile,
      deviceId: DeviceId,
      deviceName: Schema.optionalKey(DisplayName),
      titleId: TitleId,
      episodeId: Schema.optionalKey(EpisodeId),
      /** A specific version; omit to pick the best present file. */
      fileId: Schema.optionalKey(MediaFileId),
      /** Join a room's stream: the file is the room's and `profileId` must be a member. */
      roomId: Schema.optionalKey(RoomId),
    }),
    result: StartedPlayback,
    function: "playback:createSession",
  }),
  "playback.renewToken": mutation({
    summary: "Get a fresh playback token for an active session",
    group: "playback",
    scope: "play",
    args: Schema.Struct({ sessionId: PlaybackSessionId }),
    result: RenewedToken,
    function: "playback:renewToken",
  }),
  "playback.reportProgress": mutation({
    summary: "Report this device's position",
    group: "playback",
    scope: "play",
    args: Schema.Struct({
      sessionId: PlaybackSessionId,
      positionMs: Milliseconds,
      durationMs: Schema.optionalKey(Milliseconds),
      event: ProgressEvent,
    }),
    result: ProgressReceipt,
    function: "playback:reportProgress",
  }),
  "playback.endSession": mutation({
    summary: "Stop playback on this device",
    group: "playback",
    scope: "play",
    args: Schema.Struct({ sessionId: PlaybackSessionId, positionMs: Milliseconds }),
    result: Ok,
    function: "playback:endSession",
  }),
  "playback.nextEpisode": query({
    summary: "Show the episode after this one",
    group: "playback",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, episodeId: EpisodeId }),
    result: Schema.NullOr(Episode),
    function: "playback:nextEpisode",
  }),
  "playback.active": query({
    summary: "List this account's active playback on every device",
    group: "playback",
    scope: "read",
    args: NoArgs,
    result: Schema.Array(PlaybackSession),
    function: "playback:active",
  }),
};
