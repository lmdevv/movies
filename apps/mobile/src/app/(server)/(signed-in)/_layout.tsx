/** Screens that need a session. Signed-out people go to Sign in. */
import { useAuth } from "@movies/sdk/react";
import { Redirect, Stack } from "expo-router";

import { colors } from "@/theme/tokens";
import { BlankScreen } from "@/ui/screen";

export default function SignedInLayout() {
  const { status } = useAuth();

  if (status === "loading") return <BlankScreen />;

  if (status === "signedOut") return <Redirect href="/sign-in" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}
