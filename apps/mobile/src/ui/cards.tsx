/**
 * Media cards as the iOS page draws them: the 16:9 landscape card with progress (Continue
 * watching), the 2:3 poster card with its `New` badge and facts, the wide collection card, and the
 * horizontal row that holds them. Artwork loads with a token-colored placeholder behind it.
 */
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { PAGE_INSET, black, colors, opacity, overlay, radius, space, system } from "@/theme/tokens";

import { Text } from "./text";

/** Fades art to black at the bottom so text over it reads. */
function Scrim({ from, to }: { readonly from: number; readonly to: number }) {
  return (
    <LinearGradient
      colors={[black(0), black(to)]}
      locations={[from, 1]}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}

/** Artwork filling its frame, or nothing while it has none. */
function Art({ uri }: { readonly uri: string | undefined }) {
  return uri === undefined ? null : (
    <Image
      source={{ uri }}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      transition={150}
      accessibilityIgnoresInvertColors
    />
  );
}

/** Props for `LandscapeCard`. */
interface LandscapeCardProps {
  /** The still or backdrop. */
  readonly image: string | undefined;
  /** The title drawn over the still, such as `SEVERANCE`. */
  readonly artTitle: string;
  /** The first line under the still: `Severance · S2:E4`. */
  readonly title: string;
  /** The second line: `41m left` or `Next`. */
  readonly subtitle?: string | undefined;
  /** How far through it the profile is, 0 to 1; no bar when null. */
  readonly progress?: number | null;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
}

/** Width of a landscape card on a phone. */
const LANDSCAPE_WIDTH = 228;

/** A 16:9 card with the title over its still, a progress bar, and two lines under it. */
export function LandscapeCard({
  image,
  artTitle,
  title,
  subtitle,
  progress = null,
  onPress,
  accessibilityLabel,
}: LandscapeCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.landscape, pressed && styles.pressed]}
    >
      <View style={styles.still}>
        <Art uri={image} />
        <Scrim from={0.5} to={0.6} />
        <Text variant="cardTitle" numberOfLines={1} style={styles.stillTitle}>
          {artTitle}
        </Text>
        {progress === null ? null : (
          <View style={styles.track}>
            <View style={[styles.progress, { width: `${String(Math.round(progress * 100))}%` }]} />
          </View>
        )}
      </View>
      <View style={styles.meta}>
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** Props for `PosterCard`. */
interface PosterCardProps {
  readonly image: string | undefined;
  /** The title, drawn over the poster only when there is no poster art. */
  readonly name: string;
  /** The facts under the poster: `2024 · 2h 46m`. */
  readonly caption: string;
  /** A red flag in the corner, such as `New`. */
  readonly badge?: string | undefined;
  readonly onPress: () => void;
}

/** A 2:3 poster with an optional badge and the facts under it. */
export function PosterCard({ image, name, caption, badge, onPress }: PosterCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={({ pressed }) => [styles.posterCard, pressed && styles.pressed]}
    >
      <View style={styles.poster}>
        <Art uri={image} />
        {image === undefined ? (
          <>
            <Scrim from={0.45} to={0.72} />
            <Text variant="posterTitle" numberOfLines={3} style={styles.posterTitle}>
              {name}
            </Text>
          </>
        ) : null}
        {badge === undefined ? null : (
          <View style={styles.badge}>
            <Text variant="badge" color={colors.onAccent}>
              {badge}
            </Text>
          </View>
        )}
      </View>
      {caption === "" ? null : (
        <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
          {caption}
        </Text>
      )}
    </Pressable>
  );
}

/** Props for `CollectionCard`. */
interface CollectionCardProps {
  readonly image: string | undefined;
  readonly name: string;
  /** `2 titles`. */
  readonly count: string;
  readonly onPress?: () => void;
}

/** A wide card for a collection: its backdrop with the name and title count over it. */
export function CollectionCard({ image, name, count, onPress }: CollectionCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${count}`}
      disabled={onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.collection, pressed && styles.pressed]}
    >
      <Art uri={image} />
      <Scrim from={0.35} to={0.75} />
      <View style={styles.collectionText}>
        <Text variant="collectionTitle" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="captionMedium" color={overlay.facts}>
          {count}
        </Text>
      </View>
    </Pressable>
  );
}

/** Props for `CardRow`. */
interface CardRowProps {
  readonly children: ReactNode;
}

/** A horizontal row of cards that scrolls past the page's edge. */
export function CardRow({ children }: CardRowProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: opacity.pressed },
  landscape: { width: LANDSCAPE_WIDTH, gap: space[2] },
  still: {
    width: LANDSCAPE_WIDTH,
    height: 128,
    borderRadius: radius.art,
    overflow: "hidden",
    backgroundColor: system.fill,
  },
  stillTitle: { position: "absolute", left: 12, right: 12, bottom: 14 },
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: overlay.track,
  },
  progress: { height: 3, backgroundColor: colors.accent },
  meta: { gap: 2 },
  posterCard: { width: 110, gap: 6 },
  poster: {
    width: 110,
    height: 165,
    borderRadius: radius.art,
    overflow: "hidden",
    backgroundColor: system.fill,
  },
  posterTitle: { position: "absolute", left: 9, right: 9, bottom: 10 },
  badge: {
    position: "absolute",
    top: 6,
    left: 6,
    borderRadius: radius.poster,
    paddingHorizontal: 6,
    paddingVertical: 1,
    backgroundColor: colors.accent,
  },
  collection: {
    width: 280,
    height: 158,
    borderRadius: radius.art,
    overflow: "hidden",
    backgroundColor: system.fill,
  },
  collectionText: { position: "absolute", left: 14, right: 14, bottom: 12, gap: 2 },
  row: { gap: 10, paddingHorizontal: PAGE_INSET },
});
