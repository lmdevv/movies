/**
 * The two Paper typefaces as static weights: Inter Tight for all UI, Geist Mono for addresses,
 * paths, and codes. React Native picks a weight by family name, so each weight registers under
 * the family name `tokens.fontFamily` uses.
 */
import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { InterTight_400Regular } from "@expo-google-fonts/inter-tight/400Regular";
import { InterTight_500Medium } from "@expo-google-fonts/inter-tight/500Medium";
import { InterTight_600SemiBold } from "@expo-google-fonts/inter-tight/600SemiBold";
import { InterTight_700Bold } from "@expo-google-fonts/inter-tight/700Bold";
import { InterTight_800ExtraBold } from "@expo-google-fonts/inter-tight/800ExtraBold";
import { InterTight_900Black } from "@expo-google-fonts/inter-tight/900Black";

import { fontFamily } from "./tokens";

/** Font assets by the family names text styles use. */
export const FONTS = {
  [fontFamily.regular]: InterTight_400Regular,
  [fontFamily.medium]: InterTight_500Medium,
  [fontFamily.semibold]: InterTight_600SemiBold,
  [fontFamily.bold]: InterTight_700Bold,
  [fontFamily.heavy]: InterTight_800ExtraBold,
  [fontFamily.black]: InterTight_900Black,
  [fontFamily.mono]: GeistMono_400Regular,
} as const;
