/**
 * The root: fonts, the portrait lock, and what the phone remembers. Each route group below adds
 * one requirement: `(server)` a connected server, `(signed-in)` a session, `(profile)` a chosen,
 * unlocked profile. Without one, its layout sends people to Connect, Sign in, or Who's watching.
 */
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform } from "react-native";

import { DeviceProvider } from "@/device/device-state";
import { FONTS } from "@/theme/fonts";
import { colors } from "@/theme/tokens";
import { BlankScreen } from "@/ui/screen";

export default function RootLayout() {
  const [fontsLoaded] = useFonts(FONTS);

  useEffect(() => {
    // The app is portrait; the player unlocks rotation while it plays.
    if (Platform.OS === "ios") {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    }
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {fontsLoaded ? (
        <DeviceProvider fallback={<BlankScreen />}>
          <Stack
            screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
          />
        </DeviceProvider>
      ) : (
        <BlankScreen />
      )}
    </>
  );
}
