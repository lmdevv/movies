import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { ClientCapabilities } from "../media-playback";
import {
  CollectionId,
  DeviceId,
  EpisodeId,
  LibraryId,
  MediaFileId,
  PersonId,
  PlaybackSessionId,
  ProfileId,
  RoomId,
  TitleId,
} from "../ids";
import {
  ContinueWatchingItem,
  Episode,
  GenreCount,
  HistoryEntry,
  Home,
  Library,
  MediaVersion,
  PersonCard,
  SeasonEpisode,
  TitleCard,
  TitleDetail,
  TitleKind,
  TitleSort,
} from "../models/catalog";
import { Collection } from "../models/collections";
import { PersonDetail } from "../models/people";
import { DisplayName, NoArgs, Ok, Page, PageArgs } from "../models/common";
import {
  PlaybackSession,
  ProgressEvent,
  ProgressReceipt,
  RenewedToken,
  StartedPlayback,
} from "../models/playback";
import { AvatarKey, CreateProfileArgs, Pin, Profile, UnlockResult } from "../models/profiles";
import { EpochMillis, Milliseconds } from "../units";
import { mutation, query } from "./command";

const OnProfile = { profileId: ProfileId };

const FilterYear = Schema.Int.check(Schema.isBetween({ minimum: 1800, maximum: 3000 }));

const FilterText = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(100));

const ResultLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

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
      /** Only titles with this genre, matched without regard to case. */
      genre: Schema.optionalKey(FilterText),
      /** Only titles from this year on; with `yearTo`, a decade is 1990 to 1999. */
      yearFrom: Schema.optionalKey(FilterYear),
      yearTo: Schema.optionalKey(FilterYear),
      /** Only titles from this studio or network, matched without regard to case. */
      studio: Schema.optionalKey(FilterText),
      /** Only titles whose IMDb score (else TMDB score) is at least this, on a 0–10 scale. */
      minRating: Schema.optionalKey(
        Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
      ),
    }),
    result: Page(TitleCard),
    function: "titles:list",
  }),
  "titles.genres": query({
    summary: "List genres of the titles a profile may see, most common first",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, kind: Schema.optionalKey(TitleKind) }),
    result: Schema.Array(GenreCount),
    function: "titles:genres",
  }),
  "titles.similar": query({
    summary: "Show titles like this one that a profile may see",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, titleId: TitleId, limit: Schema.optionalKey(ResultLimit) }),
    result: Schema.Array(TitleCard),
    function: "titles:similar",
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
  "titles.versions": query({
    summary: "List the versions (files) of a movie or an episode, best quality first",
    group: "browse",
    scope: "read",
    args: Schema.Struct({
      ...OnProfile,
      titleId: TitleId,
      /** The episode, for shows; omit for a movie. */
      episodeId: Schema.optionalKey(EpisodeId),
    }),
    result: Schema.Array(MediaVersion),
    function: "titles:versions",
  }),
  "titles.episodes": query({
    summary: "List a season's episodes",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, titleId: TitleId, seasonNumber: Schema.Int }),
    result: Schema.Array(SeasonEpisode),
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
    args: Schema.Struct({
      ...OnProfile,
      /** Most collections to show, 1 to 200; all of them (up to 200) when omitted. */
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    }),
    result: Schema.Array(Collection),
    function: "collections:list",
  }),
  "collections.get": query({
    summary: "Show a collection and the titles a profile may see in it",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, collectionId: CollectionId }),
    result: Collection,
    function: "collections:get",
  }),
  "people.get": query({
    summary: "Show a person and the titles a profile may see them in",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, personId: PersonId }),
    result: PersonDetail,
    function: "people:get",
  }),
  "people.search": query({
    summary: "Search cast and crew by name",
    group: "browse",
    scope: "read",
    args: Schema.Struct({
      ...OnProfile,
      query: Schema.String.check(Schema.isMaxLength(200)),
      limit: Schema.optionalKey(ResultLimit),
    }),
    result: Schema.Array(PersonCard),
    function: "people:search",
  }),
  "people.requestDetails": mutation({
    summary: "Fetch a person's biography and dates if they are missing",
    group: "browse",
    scope: "read",
    args: Schema.Struct({ ...OnProfile, personId: PersonId }),
    result: Ok,
    function: "people:requestDetails",
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
      /**
       * A specific version from `titles.versions`; omit for the one this profile last played, else
       * the best quality on disk.
       */
      fileId: Schema.optionalKey(MediaFileId),
      /** Join a room's stream: the file is the room's and `profileId` must be a member. */
      roomId: Schema.optionalKey(RoomId),
      /**
       * What this device plays. Without `fileId`, a version it plays directly comes before the best
       * quality, after the one the profile last played.
       */
      capabilities: Schema.optionalKey(ClientCapabilities),
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
  "downloads.start": mutation({
    summary: "Start downloading a movie or episode to keep on this device",
    group: "playback",
    scope: "play",
    args: Schema.Struct({
      ...OnProfile,
      deviceId: DeviceId,
      deviceName: Schema.optionalKey(DisplayName),
      titleId: TitleId,
      episodeId: Schema.optionalKey(EpisodeId),
      /** A specific version from `titles.versions`; omit to choose as `playback.createSession` does. */
      fileId: Schema.optionalKey(MediaFileId),
      capabilities: Schema.optionalKey(ClientCapabilities),
    }),
    result: StartedPlayback,
    function: "downloads:start",
  }),
  "downloads.end": mutation({
    summary: "End a finished or cancelled download's session",
    group: "playback",
    scope: "play",
    args: Schema.Struct({ sessionId: PlaybackSessionId }),
    result: Ok,
    function: "downloads:end",
  }),
  "downloads.recordProgress": mutation({
    summary: "Save progress made while playing a download offline",
    group: "playback",
    scope: "play",
    args: Schema.Struct({
      ...OnProfile,
      titleId: TitleId,
      episodeId: Schema.optionalKey(EpisodeId),
      fileId: MediaFileId,
      positionMs: Milliseconds,
      durationMs: Milliseconds,
      /** When the device played to `positionMs`, by its clock; newer progress elsewhere wins. */
      playedAt: EpochMillis,
      /** The device's clock as it sends this, so the server corrects `playedAt` for its skew. */
      sentAt: EpochMillis,
    }),
    result: ProgressReceipt,
    function: "downloads:recordProgress",
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
