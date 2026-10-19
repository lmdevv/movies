/** Import from Jellyfin or Plex (J01–J06): one stack sharing what Connect found. */
import { Stack } from "expo-router";

import { ImportProvider } from "@/components/owner/import-state";

export default function ImportLayout() {
  return (
    <ImportProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </ImportProvider>
  );
}
