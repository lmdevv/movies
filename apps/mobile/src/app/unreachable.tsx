/**
 * A08 · Server Unavailable after Connect to Server, or A12 · Local Network Access when the address
 * is on this network, where iOS refuses connections until local network access is allowed.
 */
import { router, useLocalSearchParams } from "expo-router";
import { Wifi } from "lucide-react-native";
import { Linking } from "react-native";

import { ServerUnavailable } from "@/components/server-unavailable";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { discoverServer, normalizeServerUrl } from "@/lib/discovery";
import { displayHost, isLocalNetworkUrl } from "@/lib/local-network";
import { useConnectAttempt } from "@/session/connect-attempt";

const back = () => router.back();

export default function Unreachable() {
  const { address = "" } = useLocalSearchParams<{ address?: string }>();
  const { busy, run } = useConnectAttempt();
  const url = normalizeServerUrl(address) ?? address;

  if (isLocalNetworkUrl(url)) {
    return (
      <Screen header={<NavHeader title="Local Network Access" onBack={back} />}>
        <CalmState
          icon={Wifi}
          title="Local server unavailable"
          description="Allow local network access in Settings."
          actions={
            <>
              <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
              <Button label="Enter a Remote Address" variant="secondary" onPress={back} />
            </>
          }
        />
      </Screen>
    );
  }

  return (
    <ServerUnavailable
      description={`${displayHost(url)} is unavailable.`}
      onRetry={() => void run(() => discoverServer(address), { filled: address !== "" })}
      retrying={busy}
      onChangeServer={back}
      onBack={back}
    />
  );
}
