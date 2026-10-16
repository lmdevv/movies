/**
 * The kit: every shared primitive in its Paper states on one screen, for checking them against
 * Paper and for later screens to start from. Reachable at `/dev/kit`, like the web app's.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Artwork } from "@/art/artwork-kit";
import type { ArtworkName } from "@/art/artwork-kit";
import { PAGE_INSET, colors, radius, space, system } from "@/theme/tokens";
import { Avatar } from "@/ui/avatar";
import { BottomSheet } from "@/ui/bottom-sheet";
import { IconButton, PlayGlyph, PrimaryButton, SecondaryButton } from "@/ui/button";
import { CalmState } from "@/ui/calm-state";
import { CardRow, CollectionCard, LandscapeCard, PosterCard } from "@/ui/cards";
import { ErrorLine } from "@/ui/error-line";
import { Field } from "@/ui/field";
import { GroupedList, ListRow } from "@/ui/grouped-list";
import { LargeTitle, SectionHeader } from "@/ui/headers";
import { ICON_STROKE, PlusIcon, SearchIcon, SmartphoneIcon } from "@/ui/icons";
import { Text } from "@/ui/text";

const AVATARS = ["red", "blue", "green", "plum", "teal", "slate", "kids"] as const;

const ART: ReadonlyArray<ArtworkName> = [
  "dune",
  "severance",
  "interstellar",
  "arrival",
  "theBear",
  "fargo",
  "poorThings",
  "sicario",
  "topGun",
  "wildRobot",
  "bladeRunner",
];

const nothing = (): void => undefined;

/** The `[m]` tile of a server row. */
function ServerTile() {
  return (
    <View style={styles.serverTile}>
      <Text variant="badge" color={colors.accent}>
        [m]
      </Text>
    </View>
  );
}

export default function Kit() {
  const { top, bottom } = useSafeAreaInsets();
  const [sheet, setSheet] = useState(false);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: top, paddingBottom: bottom + space[12] }}
    >
      <LargeTitle
        title="Kit"
        accessory={<Avatar avatar="red" name="Alex" size={34} variant="circle" />}
      />
      <SectionHeader title="Type" first />
      <View style={styles.block}>
        <Text variant="brand" color={colors.accent}>
          [movies]
        </Text>
        <Text variant="billboard">Dune</Text>
        <Text variant="subtitleCaps">Part Two</Text>
        <Text variant="section">Continue watching</Text>
        <Text variant="body">Body text, 15 on 22.</Text>
        <Text variant="label" color={colors.textMuted}>
          Server address
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          2024 · 2h 46m
        </Text>
        <Text variant="mono">movies.home.lan</Text>
      </View>
      <SectionHeader title="Buttons" />
      <View style={styles.block}>
        <PrimaryButton label="Resume" icon={<PlayGlyph />} onPress={nothing} />
        <PrimaryButton label="Signing in" pending onPress={nothing} />
        <SecondaryButton
          label="Use a code from another device"
          icon={<SmartphoneIcon size={18} color={colors.text} strokeWidth={ICON_STROKE} />}
          onPress={nothing}
        />
        <SecondaryButton label="Manage profiles" surface="glass" onPress={nothing} />
        <View style={styles.row}>
          <IconButton
            label="Add to My List"
            surface="tint"
            icon={<PlusIcon size={20} color={colors.text} strokeWidth={2} />}
            onPress={nothing}
          />
          <IconButton
            label="Search"
            size={62}
            icon={<SearchIcon size={22} color={colors.text} strokeWidth={2} />}
            onPress={nothing}
          />
        </View>
      </View>
      <SectionHeader title="Fields" />
      <View style={styles.block}>
        <Field label="Email" placeholder="maya@home.lan" />
        <Field label="Password" secureTextEntry error="Wrong email or password." />
        <ErrorLine message="No [movies] server answered at this address." />
      </View>
      <SectionHeader title="Avatars" />
      <View style={[styles.block, styles.row]}>
        {AVATARS.map((avatar) => (
          <Avatar key={avatar} avatar={avatar} name="Alex" size={44} variant="tile" />
        ))}
      </View>
      <SectionHeader title="Cards" />
      <CardRow>
        <LandscapeCard
          image={undefined}
          artTitle="Severance"
          title="Severance · S2:E4"
          subtitle="41m left"
          progress={0.3}
          accessibilityLabel="Resume Severance"
          onPress={nothing}
        />
        <PosterCard
          image={undefined}
          name="Dune: Part Two"
          caption="2024 · 2h 46m"
          badge="New"
          onPress={nothing}
        />
        <CollectionCard image={undefined} name="Dune Collection" count="2 titles" />
      </CardRow>
      <SectionHeader title="Artwork" />
      <CardRow>
        {ART.map((name) => (
          <Artwork key={name} name={name} style={styles.art} />
        ))}
      </CardRow>
      <SectionHeader title="Grouped list" />
      <View style={styles.block}>
        <GroupedList separatorInset={66}>
          <ListRow
            title="Alex's [movies]"
            subtitle="192.168.1.20:3001"
            subtitleFont="mono"
            leading={<ServerTile />}
            onPress={nothing}
          />
          <ListRow
            title="Studio [movies]"
            subtitle="10.0.0.8:3001"
            subtitleFont="mono"
            leading={<ServerTile />}
            onPress={nothing}
          />
        </GroupedList>
        <SecondaryButton label="Open a sheet" onPress={() => setSheet(true)} />
      </View>
      <SectionHeader title="Calm state" />
      <View style={styles.calm}>
        <CalmState
          title="Home didn't load"
          description="Can't reach the server. Check the connection and try again."
          actions={<PrimaryButton label="Try again" onPress={nothing} />}
        />
      </View>
      <BottomSheet open={sheet} onClose={() => setSheet(false)}>
        <View style={styles.block}>
          <Text variant="section">Version</Text>
          <Text variant="body" color={colors.textMuted}>
            4K · HDR10 · HEVC · EAC3 5.1 · 41.2 GB
          </Text>
          <PrimaryButton label="Done" onPress={() => setSheet(false)} />
        </View>
      </BottomSheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  block: { gap: space[3], paddingHorizontal: PAGE_INSET },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space[3] },
  art: { width: 160, height: 90, borderRadius: radius.art },
  calm: { height: 320 },
  serverTile: {
    width: 36,
    height: 36,
    borderRadius: radius.art,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: system.fillRaised,
  },
});
