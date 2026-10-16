/**
 * Who's watching (B1): the account's profiles as avatar tiles. Choosing one remembers it on this
 * phone and goes Home; a profile with a PIN this session has not unlocked opens its PIN screen.
 */
import type { Profile } from "@movies/contracts/models/profiles";
import { describeFailure } from "@movies/sdk/failure";
import { useCommandQuery } from "@movies/sdk/react";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Artwork } from "@/art/artwork-kit";
import { useProfileChoice } from "@/session/profile-choice";
import { PAGE_INSET, black, colors, opacity, radius, space, system } from "@/theme/tokens";
import { Avatar } from "@/ui/avatar";
import { PrimaryButton, SecondaryButton } from "@/ui/button";
import { CalmState } from "@/ui/calm-state";
import { ErrorLine } from "@/ui/error-line";
import { Glass } from "@/ui/glass";
import { ICON_STROKE, LockIcon, PencilIcon, PlusIcon } from "@/ui/icons";
import { BlankScreen } from "@/ui/screen";
import { Text } from "@/ui/text";

/** Profiles an account may have; Add profile shows below it. */
const MAX_PROFILES = 10;

/** Size of a profile tile. */
const TILE = 96;

/** Paper's scrim over the art. */
const SCRIM = {
  colors: [black(0.3), black(0.5), black(1)],
  locations: [0, 0.45, 0.98],
} as const;

export default function WhosWatching() {
  const profiles = useCommandQuery("profiles.list", {});

  if (profiles.status === "loading") return <BlankScreen />;

  if (profiles.status === "error") {
    return (
      <View style={styles.screen}>
        <CalmState
          title="Something went wrong"
          description={describeFailure(profiles.error)}
          actions={<PrimaryButton label="Try again" onPress={profiles.retry} />}
        />
      </View>
    );
  }

  return <ProfilePicker profiles={profiles.data} />;
}

function ProfilePicker({ profiles }: { readonly profiles: ReadonlyArray<Profile> }) {
  const router = useRouter();
  const { top, bottom } = useSafeAreaInsets();
  const { choose } = useProfileChoice();
  const [error, setError] = useState<string | null>(null);

  const pick = async (profile: Profile): Promise<void> => {
    setError(null);

    try {
      await choose(profile.id);
    } catch (cause) {
      setError(describeFailure(cause));

      return;
    }

    if (profile.locked) {
      router.push({ pathname: "/profiles/[profileId]/pin", params: { profileId: profile.id } });
    } else {
      router.replace("/");
    }
  };

  return (
    <View style={styles.screen}>
      <Artwork name="interstellar" style={styles.art} />
      <LinearGradient
        colors={SCRIM.colors}
        locations={SCRIM.locations}
        style={styles.scrim}
        pointerEvents="none"
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: top }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <Text variant="brandSmall" color={colors.accent}>
            [movies]
          </Text>
        </View>
        <View style={styles.picker}>
          <Text variant="largeTitle" accessibilityRole="header" style={styles.center}>
            Who's watching?
          </Text>
          <View style={styles.grid}>
            {profiles.map((profile) => (
              <ProfileTile key={profile.id} profile={profile} onPress={() => void pick(profile)} />
            ))}
            {profiles.length < MAX_PROFILES ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add profile"
                onPress={() => router.push("/profiles/new")}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              >
                <Glass radius={radius.tile} style={styles.addTile}>
                  <PlusIcon size={34} color={colors.text} strokeWidth={ICON_STROKE} />
                </Glass>
                <Text variant="bodyStrong" color={colors.textMuted}>
                  Add profile
                </Text>
              </Pressable>
            ) : null}
          </View>
          {error === null ? null : <ErrorLine message={error} />}
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(bottom, 44) }]}>
        <SecondaryButton
          label="Manage profiles"
          surface="glass"
          icon={<PencilIcon size={18} color={colors.text} strokeWidth={ICON_STROKE} />}
          onPress={() => router.push("/profiles/manage")}
        />
      </View>
    </View>
  );
}

/** Props for `ProfileTile`. */
interface ProfileTileProps {
  readonly profile: Profile;
  readonly onPress: () => void;
}

function ProfileTile({ profile, onPress }: ProfileTileProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={profile.hasPin ? `${profile.name}, locked` : profile.name}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <View style={styles.avatar}>
        <Avatar avatar={profile.avatar} name={profile.name} size={TILE} variant="tile" />
        {profile.hasPin ? (
          <View style={styles.lock}>
            <LockIcon size={13} color={colors.text} strokeWidth={2.5} />
          </View>
        ) : null}
      </View>
      <Text variant="bodyStrong" numberOfLines={1}>
        {profile.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  art: {
    position: "absolute",
    top: 10,
    left: -150,
    width: 690,
    height: 420,
    borderRadius: radius.art,
    opacity: 0.75,
  },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, height: 470 },
  content: { flexGrow: 1, paddingHorizontal: PAGE_INSET, paddingBottom: space[6] },
  brand: { height: 44, alignItems: "center", justifyContent: "center" },
  picker: { alignItems: "center", paddingTop: 196, gap: 36 },
  center: { textAlign: "center" },
  grid: {
    width: TILE * 2 + 48,
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: space[12],
    rowGap: 28,
  },
  tile: { width: TILE, alignItems: "center", gap: 10 },
  avatar: {
    width: TILE,
    height: TILE,
    borderRadius: radius.tile,
    boxShadow: `0 12px 30px ${black(0.45)}`,
  },
  lock: {
    position: "absolute",
    right: -6,
    bottom: -6,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 3,
    borderColor: colors.bg,
    backgroundColor: system.fillRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  addTile: {
    width: TILE,
    height: TILE,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: opacity.pressed },
  footer: { paddingHorizontal: PAGE_INSET, paddingTop: space[3] },
});
