import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { CloudOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, View } from "react-native";
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
import { SessionPhaseContext, useLiveSessionPhase, useSettledPhase } from "@/session/session-phase";
import { useSignOut } from "@/session/viewer";
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

/** How long the session may load before the screen offers a way out. */
const SLOW_LOAD_MS = 8000;

/** Whether `loading` has lasted longer than `SLOW_LOAD_MS`. */
const useSlowLoad = (loading: boolean): boolean => {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);

    if (!loading) return undefined;
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);

    return () => clearTimeout(timer);
  }, [loading]);

  return slow;
};

/**
 * Shown instead of the splash when the session cannot load, such as when the account server is
 * unreachable or the stored session was revoked: try again, sign out, or pick another server.
 */
function ConnectionTrouble({
  description,
  retry,
}: {
  readonly description: string;
  readonly retry?: () => void;
}) {
  const { disconnect } = useConnection();
  const signOut = useSignOut();

  return (
    <Screen>
      <HideSplash />
      <CalmState
        icon={CloudOff}
        title="Server Unavailable"
        description={description}
        actions={
          <>
            {retry === undefined ? null : <Button label="Try Again" onPress={retry} />}
            <Button label="Change Server" variant="secondary" onPress={disconnect} />
            <Button
              label="Sign Out"
              variant="plain"
              onPress={() => {
                void signOut().catch((cause: unknown) => {
                  Alert.alert("Couldn't Sign Out", describeFailure(cause));
                });
              }}
            />
          </>
        }
      />
    </Screen>
  );
}

/**
 * The connected app: the SDK on the server, the profile choice, and the phase's screens. Trouble
 * covers the screens rather than replacing them, so Try Again returns to where people were.
 */
function ConnectedApp() {
  const phase = useLiveSessionPhase();
  const settled = useSettledPhase(phase);
  const slow = useSlowLoad(phase.kind === "loading");

  let trouble: ReactNode = null;

  if (phase.kind === "unavailable") {
    trouble = <ConnectionTrouble description={describeFailure(phase.cause)} retry={phase.retry} />;
  } else if (phase.kind === "loading" && slow) {
    trouble = (
      <ConnectionTrouble description="The server isn't answering. Check the connection, or choose another server." />
    );
  }

  if (settled === null) return trouble;

  return (
    <SessionPhaseContext.Provider value={settled}>
      <ActiveProfileContext.Provider value={settled.kind === "ready" ? settled.active : null}>
        <HideSplash />
        <RootStack phase={settled.kind} />
        {trouble === null ? null : (
          // Modal for VoiceOver too, so the covered screens can't be reached underneath.
          <View className="absolute inset-0" accessibilityViewIsModal>
            {trouble}
          </View>
        )}
      </ActiveProfileContext.Provider>
    </SessionPhaseContext.Provider>
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
