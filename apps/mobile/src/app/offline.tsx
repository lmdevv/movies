/**
 * The Downloads list (C19) while the server cannot be reached, opened from A08 · Server
 * Unavailable: the profile's downloads play from this iPhone, and Try Again goes back to the
 * server.
 */
import { DownloadsList } from "@/components/downloads/downloads-list";
import { Button } from "@/components/ui/button";
import { useOffline } from "@/session/offline";

export default function OfflineDownloads() {
  const offline = useOffline();
  const leave = () => offline?.leave();

  return (
    <DownloadsList
      chrome="own"
      empty={{ label: "Try Again", onPress: leave }}
      footer={<Button label="Try Again" variant="secondary" onPress={leave} />}
    />
  );
}
