/**
 * G02–G08 · A watch room on the phone, where room links and Home's room pill lead: join it (G03),
 * or, once in it, see the shared timeline and who is watching (G02 host, G04 guest, G05 while the
 * host buffers), and open the room's player from the artwork. A guest whose host left keeps
 * watching alone or goes home (G06); an ended room (G07) or one this profile may not watch (G08)
 * says so.
 */
import { targetPosition } from "@movies/contracts/clock";
import type { RoomId } from "@movies/contracts/ids";
import type { Room } from "@movies/contracts/models/rooms";
import { EpochMillis } from "@movies/contracts/units";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import {
  ChevronLeft,
  CircleAlert,
  Ellipsis,
  LockKeyhole,
  Play,
  Share,
  UserRound,
  UsersRound,
} from "lucide-react-native";
import { ActionSheetIOS, ActivityIndicator, ScrollView, View } from "react-native";

import { goBack, useJoinRoom, useServerClock } from "@/components/rooms/room-actions";
import { RoomArtwork, RoomMemberRow, RoomStage, useNow } from "@/components/rooms/room-parts";
import { roomIdParam } from "@/components/title/route-params";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";
import { formatClock } from "@/lib/player/clock";
import { episodeLine } from "@/lib/player/next-episode";
import { memberRows, roomAccess, roomNotice } from "@/lib/rooms/room-view";
import type { RoomRole } from "@/lib/rooms/room-view";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

/** Home, from wherever the room was opened. */
const goHome = (): void => {
  router.dismissTo("/");
};

/** The room's player, in the room. */
const watchHrefFor = (room: Room): string =>
  watchHref({ titleId: room.title.id, episodeId: room.episode?.id, room: room.id });

/** The artwork a room shows: the episode's still, else the title's wide art. */
const artworkKey = (room: Room): string | null =>
  room.episode?.still ?? room.title.artwork.backdrop ?? room.title.artwork.poster;

/** `S1, E2 · Half Loop` under a show's name. */
const roomEpisode = (room: Room): string | null =>
  room.episode === null ? null : episodeLine(room.episode);

/** G03 · Join: the room's title and host, then Join Room or Not Now. */
function JoinRoom({ room }: { readonly room: Room }) {
  const { mediaUrl } = useServer();
  const { busy, error, join } = useJoinRoom(room.id);
  const line = roomEpisode(room);

  const joinRoom = () => {
    void join().then((joined) => {
      if (joined) router.replace(watchHrefFor(room));

      return undefined;
    });
  };

  return (
    <Screen header={<NavHeader title={`Join ${room.hostProfileName}`} />}>
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <RoomArtwork uri={artworkUrl(mediaUrl, artworkKey(room), "backdrop")} />
        <View className="gap-1">
          <Text variant="title" accessibilityRole="header">
            {room.title.name}
          </Text>
          {line === null ? null : (
            <Text variant="secondary" tone="muted">
              {line}
            </Text>
          )}
        </View>
        <ListRow icon={UserRound} title={room.hostProfileName} detail="Host" />
        {room.members.length === 0 ? null : (
          <ListRow icon={UsersRound} title={`${String(room.members.length)} Watching`} />
        )}
        <View className="h-6" />
        {error === null ? null : (
          <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <Button label="Join Room" icon={UsersRound} busy={busy} onPress={joinRoom} />
        <Button label="Not Now" variant="secondary" onPress={goBack} />
      </ScrollView>
    </Screen>
  );
}

/** The ••• menu: the host's Invite People and End Room, a guest's Leave Room. */
const openMenu = (room: Room, role: RoomRole, leave: () => void): void => {
  const options =
    role === "host" ? ["Invite People", "End Room", "Cancel"] : ["Leave Room", "Cancel"];

  ActionSheetIOS.showActionSheetWithOptions(
    { options, cancelButtonIndex: options.length - 1, destructiveButtonIndex: options.length - 2 },
    (index) => {
      if (role === "guest") {
        if (index === 0) leave();

        return;
      }

      if (index === 0) router.push(`/room/${room.id}/invite`);

      if (index === 1) router.push(`/room/${room.id}/end`);
    },
  );
};

/** G02, G04, G05 · In the room: the shared timeline, who is watching, and the way to the player. */
function InRoom({ room, role }: { readonly room: Room; readonly role: RoomRole }) {
  const { mediaUrl } = useServer();
  const { profile } = useActiveProfile();
  const leaveRoom = useCommand("rooms.leave");
  const device = deviceId();
  const playing = room.clock.status === "playing";
  const now = useNow(playing, 1_000);
  // The shared position by the server's clock, as the room's players read it.
  const clock = useServerClock(room.id);
  const positionMs = targetPosition(room.clock, EpochMillis.make(Math.round(now + clock.offsetMs)));
  const notice = roomNotice(room, role);
  const line = roomEpisode(room);

  const versions = useCommandQuery(
    "titles.versions",
    room.episode === null
      ? { profileId: profile.id, titleId: room.title.id }
      : { profileId: profile.id, titleId: room.title.id, episodeId: room.episode.id },
  );

  const durationMs =
    versions.status === "success"
      ? (versions.data.find((version) => version.id === room.fileId)?.durationMs ?? null)
      : null;

  const leave = () => {
    void leaveRoom({ roomId: room.id, deviceId: device }).catch(() => undefined);
    goBack();
  };

  return (
    <Screen
      header={
        <NavHeader
          title="Watch Together"
          trailing={
            <IconButton
              icon={Ellipsis}
              label="Room Actions"
              onPress={() => openMenu(room, role, leave)}
            />
          }
        />
      }
    >
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <RoomStage
          uri={artworkUrl(mediaUrl, artworkKey(room), "backdrop")}
          status={room.clock.status}
          title={room.title.name}
          onWatch={() => router.push(watchHrefFor(room))}
        />
        <View className="gap-1">
          <Text variant="heading" accessibilityRole="header">
            {room.title.name}
          </Text>
          {line === null ? null : (
            <Text variant="secondary" tone="muted">
              {line}
            </Text>
          )}
        </View>
        {durationMs === null || durationMs <= 0 ? null : (
          <ProgressBar value={Math.min(1, positionMs / durationMs)} />
        )}
        <View className="flex-row items-center justify-between gap-3">
          <Text variant="metaStrong" tone="muted">
            {formatClock(positionMs / 1000)}
          </Text>
          {notice === null ? null : (
            <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
              <Text variant="labelStrong" numberOfLines={1}>
                {notice.text}
              </Text>
            </View>
          )}
        </View>
        <Text variant="heading" accessibilityRole="header">
          Watching
        </Text>
        {memberRows(room, device).map((row) => (
          <RoomMemberRow key={row.id} row={row} />
        ))}
        {role === "host" ? (
          <Button
            label="Invite People"
            icon={Share}
            variant="secondary"
            onPress={() => router.push(`/room/${room.id}/invite`)}
          />
        ) : (
          <Button label="Leave Room" icon={ChevronLeft} variant="secondary" onPress={leave} />
        )}
      </ScrollView>
    </Screen>
  );
}

/** G06 · The host left: keep watching alone from where the room paused, or go home. */
function HostLeft({ room }: { readonly room: Room }) {
  const leaveRoom = useCommand("rooms.leave");

  const leave = () => {
    void leaveRoom({ roomId: room.id, deviceId: deviceId() }).catch(() => undefined);
  };

  return (
    <Screen header={<NavHeader />}>
      <CalmState
        placement="top"
        icon={UsersRound}
        title={`${room.hostProfileName} left the room.`}
        description={`Continue on your own from ${formatClock(room.clock.positionAtAnchorMs / 1000)}.`}
        actions={
          <>
            <Button
              label="Continue Watching"
              icon={Play}
              iconFilled
              onPress={() => {
                leave();
                router.replace(
                  watchHref({
                    titleId: room.title.id,
                    episodeId: room.episode?.id,
                    at: room.clock.positionAtAnchorMs,
                  }),
                );
              }}
            />
            <Button
              label="Back to Home"
              variant="secondary"
              onPress={() => {
                leave();
                goHome();
              }}
            />
          </>
        }
      />
    </Screen>
  );
}

/** A room by its ID, as this device stands with it. */
function RoomView({ roomId }: { readonly roomId: RoomId }) {
  const { profile } = useActiveProfile();
  const read = useCommandQuery("rooms.get", { roomId, profileId: profile.id });
  const access = roomAccess(read, deviceId(), profile.id);

  if (access.kind === "loading") {
    return (
      <Screen header={<NavHeader title="Watch Together" />}>
        <ActivityIndicator className="flex-1" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (access.kind === "join") return <JoinRoom room={access.room} />;

  if (access.kind === "member") return <InRoom room={access.room} role={access.role} />;

  if (access.kind === "hostLeft") return <HostLeft room={access.room} />;

  if (access.kind === "ended") {
    return (
      <Screen header={<NavHeader />}>
        <CalmState
          placement="top"
          icon={UsersRound}
          title="This room has ended."
          actions={<Button label="Back to Home" onPress={goHome} />}
        />
      </Screen>
    );
  }

  if (access.kind === "denied") {
    return (
      <Screen header={<NavHeader />}>
        <CalmState
          placement="top"
          icon={LockKeyhole}
          title="This room isn’t available."
          description="This profile can’t watch what this room is playing."
          actions={
            <>
              <Button label="Switch Profile" onPress={() => router.push("/switch-profile")} />
              <Button label="Back to Home" variant="secondary" onPress={goHome} />
            </>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen header={<NavHeader />}>
      <CalmState
        icon={CircleAlert}
        title="Couldn’t Open This Room"
        description={describeFailure(access.error)}
        actions={
          read.status === "error" ? <Button label="Try Again" onPress={read.retry} /> : undefined
        }
      />
    </Screen>
  );
}

export default function RoomScreen() {
  const params = useLocalSearchParams<{ roomId: string }>();
  const roomId = roomIdParam(params.roomId);

  if (roomId === null) {
    return (
      <Screen header={<NavHeader />}>
        <CalmState placement="top" icon={LockKeyhole} title="This room isn’t available." />
      </Screen>
    );
  }

  return <RoomView key={roomId} roomId={roomId} />;
}
