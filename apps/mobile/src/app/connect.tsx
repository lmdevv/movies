/**
 * Connect to server (A1): one address, typed. The app looks for a media service at what it could
 * mean, asks it for the Convex URL to sign in with, and remembers both. Finding servers on this
 * network (Bonjour) needs a native build and comes later.
 */
import { ServerLookup } from "@movies/sdk/effect";
import { Effect, Result } from "effect";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";

import { Artwork } from "@/art/artwork-kit";
import type { ArtworkName } from "@/art/artwork-kit";
import { useDevice } from "@/device/device-state";
import { PAGE_INSET, black, colors, radius, space, system } from "@/theme/tokens";
import { PrimaryButton } from "@/ui/button";
import { Field } from "@/ui/field";
import { ICON_STROKE, ServerIcon } from "@/ui/icons";
import { Text } from "@/ui/text";

/** The poster wall behind the form, column by column, as Paper lays it out. */
const WALL: ReadonlyArray<{
  readonly offset: number;
  readonly posters: ReadonlyArray<ArtworkName>;
}> = [
  { offset: 40, posters: ["severance", "poorThings", "wildRobot"] },
  { offset: 0, posters: ["dune", "theBear", "bladeRunner"] },
  { offset: 64, posters: ["interstellar", "fargo", "sicario"] },
  { offset: 24, posters: ["arrival", "topGun", "severance"] },
];

/** Paper's scrim over the wall: dim at the top, black where the form starts. */
const SCRIM = {
  colors: [black(0.35), black(0.55), black(1)],
  locations: [0, 0.4, 0.82],
} as const;

/** The address field shows the remembered server without its scheme. */
const shownAddress = (mediaUrl: string | undefined): string =>
  mediaUrl === undefined ? "" : mediaUrl.replace(/^https?:\/\//u, "");

export default function Connect() {
  const router = useRouter();
  const { server, connect } = useDevice();
  const [address, setAddress] = useState(() => shownAddress(server?.mediaUrl));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);

    const result = await Effect.runPromise(Effect.result(ServerLookup.lookup(address)));

    if (Result.isFailure(result)) {
      setError(result.failure.message);
      setPending(false);

      return;
    }

    await connect(result.success);
    router.replace("/");
  };

  return (
    <View style={styles.screen}>
      <PosterWall />
      <LinearGradient
        colors={SCRIM.colors}
        locations={SCRIM.locations}
        style={styles.scrim}
        pointerEvents="none"
      />
      {/* The padding goes on an inner view: with behavior "padding", KeyboardAvoidingView
          replaces its own paddingBottom, which dropped the safe-area gap on iOS. */}
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.content}>
          <View style={styles.heading}>
            <Text variant="brand" color={colors.accent}>
              [movies]
            </Text>
            <Text variant="largeTitle" accessibilityRole="header">
              Find your server.
            </Text>
          </View>
          <View style={styles.form}>
            <Field
              label="Server address"
              font="mono"
              placeholder="movies.home.lan"
              value={address}
              onChangeText={(text) => {
                setAddress(text);
                setError(null);
              }}
              error={error}
              icon={<ServerIcon size={18} color={system.glyph} strokeWidth={ICON_STROKE} />}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
            <PrimaryButton label="Continue" pending={pending} onPress={() => void submit()} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Size of a poster on the wall. */
const POSTER = { width: 104, height: 156 } as const;

function PosterWall() {
  return (
    <View style={styles.wall} pointerEvents="none">
      {WALL.map((column) => (
        <View key={column.offset} style={[styles.column, { paddingTop: column.offset }]}>
          {column.posters.map((name, index) => (
            <Artwork key={`${name}-${String(index)}`} name={name} style={styles.poster} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  wall: {
    position: "absolute",
    left: -36,
    top: -40,
    width: 470,
    height: 470,
    flexDirection: "row",
    gap: 10,
    opacity: 0.55,
    transform: [{ rotate: "-8deg" }],
    transformOrigin: "0% 0%",
  },
  column: { gap: 10 },
  poster: { ...POSTER, borderRadius: radius.art },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, height: 520 },
  avoider: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: PAGE_INSET,
    paddingBottom: 44,
  },
  heading: { gap: 10, paddingBottom: 28 },
  form: { gap: space[4] },
});
