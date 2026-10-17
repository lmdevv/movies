import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { CloudOff } from "lucide-react-native";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Screen } from "@/components/ui/screen";
import { applyAppearance } from "@/lib/appearance";
import { describeFailure } from "@/lib/failure";
import { useThemeColor } from "@/lib/theme-color";
import { ActiveProfileContext } from "@/session/active-profile";
import { ConnectionProvider, useConnection } from "@/session/connection";
import { ProfileChoiceProvider } from "@/session/profile-choice";
import { SdkProvider } from "@/session/sdk-provider";
import { useSessionPhase } from "@/session/session-phase";
import type { SessionPhase } from "@/session/session-phase";

applyAppearance();

void SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from "expo-router";

/** React Navigation's colors from the theme tokens, so native headers and sheets match. */
function NavigationTheme({ children }: { readonly children: ReactNode }) {
  const { theme } = useUniwind();
  const background = useThemeColor("--color-bg");
  const card = useThemeColor("--color-surface");
  const text = useThemeColor("--color-text");
  const border = useThemeColor("--color-hairline");
  const primary = useThemeColor("--color-accent");
  const base = theme === "light" ? DefaultTheme : DarkTheme;

  return (
    <ThemeProvider
      value={{
        ...base,
        colors: { ...base.colors, background, card, text, border, primary, notification: primary },
      }}
    >
      {children}
    </ThemeProvider>
  );
}

/**
 * Every screen, grouped by the phase that may show it. Changing phase sends the stack to the
 * first screen the new phase allows.
 */
function RootStack({ phase }: { readonly phase: SessionPhase["kind"] }) {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={phase === "disconnected"}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="connection-details" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut"}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "chooseProfile"}>
        <Stack.Screen name="profiles" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "ready"}>
        <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
        <Stack.Screen name="title/[titleId]" />
        <Stack.Screen
          name="watch/[titleId]"
          options={{
            presentation: "fullScreenModal",
            animation: "fade",
            orientation: "landscape",
            statusBarHidden: true,
            autoHideHomeIndicator: true,
          }}
        />
      </Stack.Protected>
    </Stack>
  );
}

function HideSplash() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return null;
}

/** The connected app: the SDK on the server, the profile choice, and the phase's screens. */
function ConnectedApp() {
  const phase = useSessionPhase();

  if (phase.kind === "loading") return null;

  if (phase.kind === "unavailable") {
    return (
      <Screen>
        <HideSplash />
        <CalmState
          icon={CloudOff}
          title="Server Unavailable"
          description={describeFailure(phase.cause)}
          actions={<Button label="Try Again" onPress={phase.retry} />}
        />
      </Screen>
    );
  }

  return (
    <ActiveProfileContext.Provider value={phase.kind === "ready" ? phase.active : null}>
      <HideSplash />
      <RootStack phase={phase.kind} />
    </ActiveProfileContext.Provider>
  );
}

function App() {
  const { connection } = useConnection();

  if (connection === null) {
    return (
      <>
        <HideSplash />
        <RootStack phase="disconnected" />
      </>
    );
  }

  return (
    <SdkProvider key={connection.convexUrl} connection={connection}>
      <ProfileChoiceProvider>
        <ConnectedApp />
      </ProfileChoiceProvider>
    </SdkProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationTheme>
        <ConnectionProvider>
          <App />
        </ConnectionProvider>
      </NavigationTheme>
    </GestureHandlerRootView>
  );
}
