import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { ServerUnavailable } from "@/components/server-unavailable";
import { Button } from "@/components/ui/button";
import { applyAppearance } from "@/lib/appearance";
import { describeFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useThemeColor } from "@/lib/theme-color";
import { ActiveProfileContext } from "@/session/active-profile";
import { ConnectionProvider, useConnection, useServer } from "@/session/connection";
import { InviteLinks } from "@/session/invite-links";
import {
  PendingInviteProvider,
  useDropInviteWhenSignedIn,
  usePendingInvite,
} from "@/session/pending-invite";
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

/** A native sheet sized to its content, with the grabber. */
/**
 * Every screen, grouped by the phase that may show it. Changing phase sends the stack to the
 * first screen the new phase allows.
 */
function RootStack({ phase }: { readonly phase: SessionPhase["kind"] }) {
  const invite = usePendingInvite();
  const sheet = {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,
    sheetCornerRadius: 28,
    contentStyle: { backgroundColor: useThemeColor("--color-surface-raised") },
  } as const;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={phase === "disconnected"}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="connection-details" />
        <Stack.Screen name="open-invite" />
        <Stack.Screen name="unreachable" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut" && invite.code !== null}>
        <Stack.Screen name="join" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "signedOut" && invite.code === null}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-in-code" />
      </Stack.Protected>
      <Stack.Protected guard={phase === "chooseProfile"}>
        <Stack.Screen name="profiles" options={{ animation: "fade" }} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "chooseProfile" || phase === "ready"}>
        <Stack.Screen name="manage-profiles" />
        <Stack.Screen name="profile/[profileId]" />
        <Stack.Screen name="profile-pin/[profileId]" />
        <Stack.Screen name="delete-profile/[profileId]" options={sheet} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "ready"}>
        <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
        <Stack.Screen name="switch-profile" options={sheet} />
        <Stack.Screen name="title/[titleId]" />
        <Stack.Screen name="title/[titleId]/about" />
        <Stack.Screen name="title/[titleId]/seasons" options={sheet} />
        <Stack.Screen name="title/[titleId]/versions" options={sheet} />
        <Stack.Screen name="title/[titleId]/actions" options={sheet} />
        <Stack.Screen name="title/[titleId]/episode/[episodeId]" options={sheet} />
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
 * A08 · Server Unavailable for the remembered server, shown instead of the splash when the session
 * cannot load, such as when the account server is unreachable or the stored session was revoked:
 * try again, pick another server, or sign out.
 */
function ConnectionTrouble({
  description,
  retry,
}: {
  readonly description?: string;
  readonly retry?: () => void;
}) {
  const { disconnect } = useConnection();
  const server = useServer();
  const signOut = useSignOut();

  return (
    <>
      <HideSplash />
      <ServerUnavailable
        description={description ?? `${displayHost(server.mediaUrl)} is unavailable.`}
        onRetry={retry}
        onChangeServer={disconnect}
        extra={
          <Button
            label="Sign Out"
            variant="plain"
            onPress={() => {
              void signOut().catch((cause: unknown) => {
                Alert.alert("Couldn’t Sign Out", describeFailure(cause));
              });
            }}
          />
        }
      />
    </>
  );
}

/**
 * The connected app: the SDK on the server, the profile choice, and the phase's screens. Trouble
 * covers the screens rather than replacing them, so Try Again returns to where people were.
 */
function ConnectedApp() {
  const phase = useLiveSessionPhase();
  const settled = useSettledPhase(phase);

  useDropInviteWhenSignedIn(settled !== null && settled.kind !== "signedOut");
  const slow = useSlowLoad(phase.kind === "loading");

  let trouble: ReactNode = null;

  if (phase.kind === "unavailable") {
    trouble = <ConnectionTrouble description={describeFailure(phase.cause)} retry={phase.retry} />;
  } else if (phase.kind === "loading" && slow) {
    trouble = <ConnectionTrouble />;
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
          <PendingInviteProvider>
            <InviteLinks />
            <App />
          </PendingInviteProvider>
        </ConnectionProvider>
      </NavigationTheme>
    </GestureHandlerRootView>
  );
}
