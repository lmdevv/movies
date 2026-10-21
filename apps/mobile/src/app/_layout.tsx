import "../global.css";

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useUniwind } from "uniwind";

import { StorageFullPrompt } from "@/components/downloads/storage-full-prompt";
import { ServerUnavailable } from "@/components/server-unavailable";
import { TitleStatesProvider } from "@/components/browse/title-states";
import { Button } from "@/components/ui/button";
import { applyAppearance } from "@/lib/appearance";
import { describeFailure } from "@/lib/failure";
import { displayHost } from "@/lib/local-network";
import { useSheetOptions } from "@/lib/sheet";
import { useThemeColor } from "@/lib/theme-color";
import { ActiveProfileContext } from "@/session/active-profile";
import { ConnectionProvider, useConnection, useServer } from "@/session/connection";
import { CurrentRoomProvider } from "@/session/current-room";
import { DownloadsProvider, rememberProfile, useOfflineProfile } from "@/session/downloads";
import { OfflineContext } from "@/session/offline";
import { FirstRunProvider, useHomeAfterSetup } from "@/session/first-run";
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

/**
 * Phones browse upright like the Apple TV app; only the player turns sideways. iPad follows the
 * device.
 */
const browseOrientation = Platform.OS === "ios" && Platform.isPad ? "default" : "portrait_up";

/**
 * Every screen, grouped by the phase that may show it. Changing phase sends the stack to the
 * first screen the new phase allows.
 */
function RootStack({ phase }: { readonly phase: SessionPhase["kind"] | "offline" }) {
  const invite = usePendingInvite();
  const { theme } = useUniwind();

  useHomeAfterSetup(phase);

  const sheet = useSheetOptions();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        orientation: browseOrientation,
        statusBarStyle: theme === "light" ? "dark" : "light",
      }}
    >
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
      <Stack.Protected guard={phase === "createOwner"}>
        <Stack.Screen name="create-owner" options={{ animation: "fade" }} />
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
        <Stack.Screen name="you" />
        <Stack.Screen name="my-list" />
        <Stack.Screen name="account" />
        <Stack.Screen name="change-password" />
        <Stack.Screen name="connected-server" options={sheet} />
        <Stack.Screen name="sign-out" options={sheet} />
        <Stack.Screen name="history" />
        <Stack.Screen name="history-entry" options={sheet} />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/appearance" options={sheet} />
        <Stack.Screen name="settings/audio-subtitles" />
        <Stack.Screen name="settings/choose/[preference]" />
        <Stack.Screen name="settings/about" />
        <Stack.Screen name="settings/licenses" />
        <Stack.Screen name="settings/privacy" options={sheet} />
        <Stack.Screen name="devices/index" />
        <Stack.Screen name="devices/sign-out" options={sheet} />
        <Stack.Screen name="approve-device/index" />
        <Stack.Screen name="approve-device/scan" />
        <Stack.Screen name="approve-device/[userCode]" />
        <Stack.Screen name="api-keys/index" />
        <Stack.Screen name="api-keys/new" />
        <Stack.Screen name="api-keys/revoke" options={sheet} />
        <Stack.Screen name="collections" />
        <Stack.Screen name="collection/[collectionId]" />
        <Stack.Screen name="genre/[genre]" />
        <Stack.Screen name="person/[personId]" />
        <Stack.Screen name="together/[titleId]" />
        <Stack.Screen name="room/[roomId]" />
        <Stack.Screen name="room/[roomId]/invite" options={sheet} />
        <Stack.Screen name="room/[roomId]/end" options={sheet} />
      </Stack.Protected>
      <Stack.Protected guard={phase === "offline"}>
        <Stack.Screen name="offline" options={{ animation: "fade" }} />
      </Stack.Protected>
      {/* Downloads and the player work without the server too. */}
      <Stack.Protected guard={phase === "ready" || phase === "offline"}>
        <Stack.Screen name="download/[downloadId]" />
        <Stack.Screen name="download/[downloadId]/actions" options={sheet} />
        <Stack.Screen name="download/[downloadId]/remove" options={sheet} />
        <Stack.Screen name="download/[downloadId]/storage-full" options={sheet} />
        <Stack.Screen name="download-settings/index" />
        <Stack.Screen name="download-settings/quality" options={sheet} />
        <Stack.Screen name="download-settings/remove-all" options={sheet} />
        <Stack.Screen name="download-settings/menu" options={sheet} />
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
      <Stack.Protected guard={phase === "setup" || phase === "ready"}>
        <Stack.Screen name="owner" options={phase === "setup" ? { animation: "fade" } : {}} />
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
 * try again, go to the downloads kept on this iPhone, pick another server, or sign out.
 */
function ConnectionTrouble({
  description,
  retry,
  onDownloads,
}: {
  readonly description?: string;
  readonly retry?: () => void;
  readonly onDownloads?: (() => void) | undefined;
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
          <>
            {onDownloads === undefined ? null : (
              <Button label="Go to Downloads" variant="secondary" onPress={onDownloads} />
            )}
            <Button
              label="Sign Out"
              variant="plain"
              onPress={() => {
                void signOut().catch((cause: unknown) => {
                  Alert.alert("Couldn’t Sign Out", describeFailure(cause));
                });
              }}
            />
          </>
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
  const { mediaUrl } = useServer();
  const offlineProfile = useOfflineProfile();
  const [offline, setOffline] = useState(false);

  useDropInviteWhenSignedIn(settled !== null && settled.kind !== "signedOut");
  const slow = useSlowLoad(phase.kind === "loading");
  const active = settled?.kind === "ready" ? settled.active.profile : null;

  // The profile on screen is the one whose downloads show when the server is out of reach.
  useEffect(() => {
    if (active !== null) rememberProfile(mediaUrl, active);
  }, [active, mediaUrl]);

  if (offline && offlineProfile !== null) {
    return (
      <OfflineContext.Provider
        value={{
          leave: () => {
            setOffline(false);

            if (phase.kind === "unavailable") phase.retry();
          },
        }}
      >
        <ActiveProfileContext.Provider
          value={{ profile: offlineProfile, profiles: [offlineProfile] }}
        >
          <HideSplash />
          <TitleStatesProvider>
            <CurrentRoomProvider>
              <RootStack phase="offline" />
            </CurrentRoomProvider>
          </TitleStatesProvider>
        </ActiveProfileContext.Provider>
      </OfflineContext.Provider>
    );
  }

  const toDownloads = offlineProfile === null ? undefined : () => setOffline(true);
  let trouble: ReactNode = null;

  if (phase.kind === "unavailable") {
    trouble = (
      <ConnectionTrouble
        description={describeFailure(phase.cause)}
        retry={phase.retry}
        onDownloads={toDownloads}
      />
    );
  } else if (phase.kind === "loading" && slow) {
    trouble = <ConnectionTrouble onDownloads={toDownloads} />;
  }

  if (settled === null) return trouble;

  return (
    <SessionPhaseContext.Provider value={settled}>
      <ActiveProfileContext.Provider value={settled.kind === "ready" ? settled.active : null}>
        <HideSplash />
        <TitleStatesProvider>
          <CurrentRoomProvider>
            <RootStack phase={settled.kind} />
            {settled.kind === "ready" ? <StorageFullPrompt /> : null}
          </CurrentRoomProvider>
        </TitleStatesProvider>
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
        <FirstRunProvider>
          {/* Above the phases: downloads stay reachable while the server is not. */}
          <DownloadsProvider>
            <ConnectedApp />
          </DownloadsProvider>
        </FirstRunProvider>
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
