import type { LucideIcon } from "lucide-react-native";
import { Check, Link2, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";

interface PopupAction {
  readonly label: string;
  readonly kind: "primary" | "secondary" | "destructive";
  readonly icon?: LucideIcon;
  readonly iconFilled?: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}

const ACTION_BOX = {
  primary: "bg-accent active:bg-accent-pressed",
  secondary: "bg-dark-text/10 active:opacity-70",
  destructive: "border border-dark-danger active:opacity-70",
} as const;

function ActionButton({ action }: { readonly action: PopupAction }) {
  const tone = action.kind === "destructive" ? "darkDanger" : "onMedia";

  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.busy === true}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ busy: action.busy === true }}
      className={`h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-pill px-3 ${
        ACTION_BOX[action.kind]
      }`}
    >
      {action.busy === true ? (
        <ActivityIndicator colorClassName="accent-dark-text" />
      ) : (
        <>
          {action.icon === undefined ? null : (
            <Icon
              icon={action.icon}
              tone={tone}
              size="inline"
              filled={action.iconFilled === true}
            />
          )}
          <Text variant="labelStrong" tone={tone} numberOfLines={1}>
            {action.label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Props for `PlayerPopup`. */
export interface PlayerPopupProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  /** The left action, then the right one. */
  readonly actions: readonly [PopupAction, PopupAction];
  /** A short danger line when an action failed. */
  readonly error?: string | null;
}

/** A popup over the player, dimming everything under it. */
export function PlayerPopup({ title, onClose, children, actions, error }: PlayerPopupProps) {
  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      className="absolute inset-0 items-center justify-center bg-scrim"
    >
      <Pressable className="absolute inset-0" accessibilityLabel="Close" onPress={onClose} />
      <View
        accessibilityViewIsModal
        className="w-100 max-w-full gap-4 rounded-sheet bg-dark-surface-raised p-5"
      >
        <View className="h-11 flex-row items-center gap-3">
          <Text variant="heading" tone="onMedia" className="flex-1" accessibilityRole="header">
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="size-11 items-center justify-center rounded-pill bg-dark-surface-raised active:opacity-70"
          >
            <Icon icon={X} tone="onMedia" size="inline" />
          </Pressable>
        </View>
        {children}
        {error === null || error === undefined ? null : (
          <Text variant="meta" tone="darkDanger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
        <View className="flex-row gap-2">
          <ActionButton action={actions[0]} />
          <ActionButton action={actions[1]} />
        </View>
      </View>
    </Animated.View>
  );
}

/** A popup's muted line, such as `Playback will stop for everyone.` */
export function PopupText({ children }: { readonly children: string }) {
  return (
    <Text tone="darkMuted" accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

/** What plays, with a line under it (F15 Start at, F18 the host and who watches). */
export function PopupTitle({
  name,
  detail,
  artworkUrl,
}: {
  readonly name: string;
  readonly detail: string;
  readonly artworkUrl: string | undefined;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="h-14 w-24 overflow-hidden rounded-control bg-dark-surface">
        {artworkUrl === undefined ? null : (
          <Image source={{ uri: artworkUrl }} contentFit="cover" className="absolute inset-0" />
        )}
      </View>
      <View className="flex-1 gap-1">
        <Text variant="bodyStrong" tone="onMedia" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="meta" tone="darkMuted" numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

/** The invite link in its field (F17), checked once copied. */
export function PopupLink({ link, copied }: { readonly link: string; readonly copied: boolean }) {
  return (
    <View
      className="h-11 flex-row items-center gap-3 rounded-control bg-dark-surface px-3"
      accessible
      accessibilityLabel={copied ? `Room link ${link}, copied` : `Room link ${link}`}
    >
      <Icon icon={Link2} tone="onMedia" size="inline" />
      <Text variant="secondary" tone="onMedia" className="flex-1" numberOfLines={1}>
        {link}
      </Text>
      {copied ? <Icon icon={Check} tone="onMedia" size="inline" /> : null}
    </View>
  );
}
