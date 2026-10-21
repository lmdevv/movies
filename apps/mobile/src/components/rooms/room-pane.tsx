/**
 * The player beside its Watch Together pane (F16 host, F19 guest, F20 the host buffering): the pane
 * lists who is in the room with the host's Invite People and End Room or a guest's Leave Room, and
 * the video beside it keeps compact controls. A guest follows the host, so its side shows no
 * transport, and a spinner while the host buffers.
 */
import { LinearGradient } from "expo-linear-gradient";
import type { LucideIcon } from "lucide-react-native";
import {
  Captions,
  ChevronLeft,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Share,
  X,
} from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { ScrubTile } from "@/lib/player/scrubbing";
import { useThemeColor } from "@/lib/theme-color";
import type { MemberRow, RoomNotice, RoomRole } from "@/lib/rooms/room-view";

import {
  BarAction,
  MoreMenu,
  PLAYER_MARGINS,
  RoomPill,
  RoundButton,
  SKIP_SECONDS,
  useMargin,
} from "../player/player-controls";
import type { MoreItem } from "../player/player-controls";
import { Scrubber } from "../player/scrubber";
import { Spinner } from "../player/spinner";

/** One person in the pane (F16): a 36pt tile, the name, and how they stand. */
function PaneMember({ row }: { readonly row: MemberRow }) {
  return (
    <View
      className="h-11 flex-row items-center gap-3"
      accessible
      accessibilityLabel={row.detail === null ? row.name : `${row.name}, ${row.detail}`}
    >
      <ProfileAvatar
        profile={{ name: row.name, avatar: row.avatar ?? "", kids: false }}
        size="small"
      />
      <Text variant="bodyMedium" tone="onMedia" className="flex-1" numberOfLines={1}>
        {row.name}
      </Text>
      {row.detail === null ? null : (
        <Text variant="meta" tone="darkMuted" numberOfLines={1}>
          {row.detail}
        </Text>
      )}
    </View>
  );
}

/** A 44pt pill in the pane. */
function PaneButton({
  label,
  icon,
  kind,
  onPress,
}: {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly kind: "primary" | "secondary" | "destructive";
  readonly onPress: () => void;
}) {
  const box = {
    primary: "bg-accent active:bg-accent-pressed",
    secondary: "bg-dark-surface-raised active:opacity-70",
    destructive: "border border-dark-danger active:opacity-70",
  }[kind];

  const tone = kind === "destructive" ? "darkDanger" : "onMedia";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={`h-11 flex-row items-center justify-center gap-2 rounded-pill ${box}`}
    >
      {icon === undefined ? null : <Icon icon={icon} tone={tone} size="inline" />}
      <Text variant="labelStrong" tone={tone}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Props for `RoomPane`. */
export interface RoomPaneProps {
  readonly role: RoomRole;
  readonly members: ReadonlyArray<MemberRow>;
  /** `3 Watching`, unless the notice says what the host did. */
  readonly watching: string;
  readonly notice: RoomNotice | null;
  readonly onClose: () => void;
  readonly onInvite: () => void;
  readonly onEnd: () => void;
  readonly onLeave: () => void;
  /** A guest's Continue Watching while the host is away; null otherwise. */
  readonly onContinue: (() => void) | null;
}

/** The Watch Together pane along the player's right edge. */
export function RoomPane(props: RoomPaneProps) {
  // The pane's own edge is mid-screen; only its right side meets the hardware.
  const { paddingRight } = useMargin(PLAYER_MARGINS.pane);

  return (
    <View
      className="absolute top-0 right-0 bottom-0 w-80 bg-dark-surface py-5 pl-5"
      style={{ paddingRight }}
    >
      <View className="h-11 flex-row items-center gap-2">
        <Text variant="navTitle" tone="onMedia" className="flex-1" accessibilityRole="header">
          Watch Together
        </Text>
        <Pressable
          onPress={props.onClose}
          accessibilityRole="button"
          accessibilityLabel="Close Watch Together"
          className="size-11 items-center justify-center rounded-pill bg-dark-surface-raised active:opacity-70"
        >
          <Icon icon={X} tone="onMedia" size="inline" />
        </Pressable>
      </View>
      <View className="mt-2 flex-row items-center gap-2" accessibilityLiveRegion="polite">
        {props.notice?.waiting === true ? (
          <Icon icon={LoaderCircle} tone="darkMuted" size="chevron" />
        ) : null}
        <Text variant="metaStrong" tone="darkMuted" numberOfLines={1}>
          {props.notice?.text ?? props.watching}
        </Text>
      </View>
      <ScrollView className="mt-2 grow-0" contentContainerClassName="gap-2">
        {props.members.map((row) => (
          <PaneMember key={row.id} row={row} />
        ))}
      </ScrollView>
      <View className="gap-2 pt-4">
        {props.role === "host" ? (
          <>
            <PaneButton
              label="Invite People"
              icon={Share}
              kind="primary"
              onPress={props.onInvite}
            />
            <PaneButton label="End Room" kind="destructive" onPress={props.onEnd} />
          </>
        ) : (
          <>
            {props.onContinue === null ? null : (
              <PaneButton
                label="Continue Watching"
                icon={Play}
                kind="primary"
                onPress={props.onContinue}
              />
            )}
            <PaneButton label="Leave Room" kind="secondary" onPress={props.onLeave} />
          </>
        )}
      </View>
    </View>
  );
}

/** A skip button on its own dark disc, as the compact transport draws it. */
function DiscSkip({
  direction,
  onPress,
}: {
  readonly direction: "back" | "forward";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${direction === "back" ? "Back" : "Forward"} ${String(SKIP_SECONDS)} seconds`}
      className="h-16 w-14 items-center justify-center rounded-pill bg-scrim active:opacity-70"
    >
      <Icon icon={direction === "back" ? RotateCcw : RotateCw} tone="onMedia" size="large" />
      <Text variant="metaStrong" tone="onMedia">
        {String(SKIP_SECONDS)}
      </Text>
    </Pressable>
  );
}

/** Props for `RoomViewportControls`. */
export interface RoomViewportControlsProps {
  readonly title: string;
  readonly playing: boolean;
  /** The host buffers and the room waits: a spinner where the transport would be (F20). */
  readonly waiting: boolean;
  /** Whether this player moves the room's timeline: the host's does, a guest's follows it. */
  readonly controlsTimeline: boolean;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly count: number;
  readonly more: ReadonlyArray<MoreItem>;
  readonly tileAt: (seconds: number) => ScrubTile | null;
  readonly onClose: () => void;
  readonly onTogglePlay: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onAudioSubtitles: () => void;
  readonly onRoom: () => void;
  readonly onInteract: (holding?: boolean) => void;
}

/** The compact controls over the video beside the pane. */
export function RoomViewportControls(props: RoomViewportControlsProps) {
  // The video's left edge meets the hardware; its right edge is the pane's.
  const barLeft = useMargin(PLAYER_MARGINS.pane).paddingLeft;
  const rowLeft = useMargin(PLAYER_MARGINS.compact).paddingLeft;
  const transport = props.controlsTimeline && !props.waiting;
  const scrim = useThemeColor("--color-scrim");
  const bottom = useThemeColor("--color-dark-bg");

  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      <LinearGradient
        // Paper's contrast scrim: dim at the top, clear above the middle, black at the bottom.
        colors={[scrim, "transparent", bottom]}
        locations={[0, 0.4, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        className="absolute top-4 right-5 flex-row items-center gap-3"
        style={{ left: barLeft }}
        pointerEvents="box-none"
      >
        <RoundButton icon={ChevronLeft} label="Close" onPress={props.onClose} />
        <Text variant="bodyStrong" tone="onMedia" className="flex-1" numberOfLines={1}>
          {props.title}
        </Text>
      </View>

      <View
        className="absolute inset-x-0 top-0 bottom-0 flex-row items-center justify-center gap-6"
        pointerEvents="box-none"
      >
        {props.waiting ? <Spinner /> : null}
        {transport ? (
          <>
            <DiscSkip
              direction="back"
              onPress={() => props.onSeek(props.positionSeconds - SKIP_SECONDS)}
            />
            <Pressable
              onPress={props.onTogglePlay}
              accessibilityRole="button"
              accessibilityLabel={props.playing ? "Pause" : "Play"}
              className="size-18 items-center justify-center rounded-pill bg-scrim active:opacity-70"
            >
              <Icon icon={props.playing ? Pause : Play} tone="onMedia" size="badge" filled />
            </Pressable>
            <DiscSkip
              direction="forward"
              onPress={() => props.onSeek(props.positionSeconds + SKIP_SECONDS)}
            />
          </>
        ) : null}
      </View>

      <View
        className="absolute right-6 bottom-15.5"
        style={{ left: rowLeft }}
        pointerEvents="box-none"
      >
        <Scrubber
          positionSeconds={props.positionSeconds}
          durationSeconds={props.durationSeconds}
          tileAt={props.tileAt}
          onScrubbing={(scrubbing) => props.onInteract(scrubbing)}
          onSeek={props.onSeek}
          disabled={!props.controlsTimeline}
        />
      </View>
      <View
        className="absolute right-6 bottom-4 flex-row items-center justify-between"
        style={{ left: rowLeft }}
        pointerEvents="box-none"
      >
        <BarAction icon={Captions} label="Audio & Subtitles" onPress={props.onAudioSubtitles} />
        <RoomPill count={props.count} onPress={props.onRoom} />
        {props.more.length === 0 ? (
          <View className="size-11" />
        ) : (
          <MoreMenu
            items={props.more}
            size="pane"
            onOpen={() => props.onInteract(true)}
            onRelease={() => props.onInteract(false)}
          />
        )}
      </View>
    </View>
  );
}
