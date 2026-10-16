/**
 * Screens that need a server: the SDK on a Convex client for the remembered server, and the
 * profile choice. Without a server, people go to Connect.
 */
import { MoviesProvider } from "@movies/sdk/react";
import { Redirect, Stack } from "expo-router";

import { useConvexClient } from "@/device/convex-client";
import { SESSION_KEY, useDevice } from "@/device/device-state";
import { deviceStore } from "@/device/key-value";
import { ProfileChoiceProvider } from "@/session/profile-choice";
import { colors } from "@/theme/tokens";
import { BlankScreen } from "@/ui/screen";

export default function ServerLayout() {
  const { server } = useDevice();
  const client = useConvexClient(server?.convexUrl ?? null);

  if (server === null) return <Redirect href="/connect" />;

  if (client === null) return <BlankScreen />;

  return (
    <MoviesProvider
      key={server.convexUrl}
      client={client}
      mediaUrl={server.mediaUrl}
      storage={deviceStore}
      storageKey={SESSION_KEY}
    >
      <ProfileChoiceProvider>
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
        />
      </ProfileChoiceProvider>
    </MoviesProvider>
  );
}
