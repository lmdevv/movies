/**
 * Whole screens with no content of their own: the blank page drawn while something loads, and the
 * placeholder for screens a later build fills in.
 */
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PAGE_INSET, colors, space } from "@/theme/tokens";

import { IconButton } from "./button";
import { LargeTitle } from "./headers";
import { ChevronLeftIcon, ICON_STROKE } from "./icons";

/** The page's black, drawn while a guard or the keychain answers. */
export function BlankScreen() {
  return <View style={styles.screen} />;
}

/** Props for `PlaceholderScreen`. */
interface PlaceholderScreenProps {
  /** A large title, for tab screens. */
  readonly title?: string;
  /** Draws a back button, for pushed screens. */
  readonly back?: boolean;
}

/** A screen that exists so navigation to it works, with its title and nothing else yet. */
export function PlaceholderScreen({ title, back = false }: PlaceholderScreenProps) {
  const router = useRouter();
  const { top } = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { paddingTop: top }]}>
      {back ? (
        <IconButton
          label="Back"
          size={44}
          icon={<ChevronLeftIcon size={22} color={colors.text} strokeWidth={ICON_STROKE} />}
          onPress={() => router.back()}
          style={styles.back}
        />
      ) : null}
      {title === undefined ? null : <LargeTitle title={title} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  back: { alignSelf: "flex-start", marginLeft: PAGE_INSET - 4, marginTop: space[1] },
});
