/**
 * I01 · Owner Settings: Libraries and Users & Invites with their counts, Import from Jellyfin or
 * Plex, Backups, and Server. Each row shows only when this session may use it: libraries need
 * `manage`; people, import, and backups need `admin`. During first run the owner screens open on
 * Add Your First Library instead.
 */
import { useCommandQuery } from "@movies/sdk/react";
import { Redirect, router } from "expo-router";
import { Download, Folder, Server, Settings2, Users } from "lucide-react-native";

import { OwnerScreen } from "@/components/owner/parts";
import { useOwnerViewer } from "@/components/owner/viewer";
import { ListRow } from "@/components/ui/list-row";
import { householdOf } from "@/lib/household";
import { formatCount } from "@/lib/owner-format";
import { useSessionPhase } from "@/session/session-phase";

export default function OwnerSettings() {
  const phase = useSessionPhase();

  // First run opens the owner screens on Add Your First Library (I15) rather than here.
  if (phase.kind === "setup") return <Redirect href="/owner/first-library" />;

  return <OwnerSettingsList />;
}

function OwnerSettingsList() {
  const { scopes } = useOwnerViewer();
  const manage = scopes.includes("manage");
  const admin = scopes.includes("admin");
  const libraries = useCommandQuery("libraries.listDetails", manage ? {} : "skip");
  const users = useCommandQuery("users.list", admin ? {} : "skip");

  return (
    <OwnerScreen title="Owner Settings" fallback="/">
      {manage ? (
        <ListRow
          icon={Folder}
          title="Libraries"
          detail={libraries.status === "success" ? formatCount(libraries.data.length) : undefined}
          onPress={() => router.push("/owner/libraries")}
        />
      ) : null}
      {admin ? (
        <>
          <ListRow
            icon={Users}
            title="Users & Invites"
            detail={
              users.status === "success" ? formatCount(householdOf(users.data).length) : undefined
            }
            onPress={() => router.push("/owner/users")}
          />
          <ListRow
            icon={Download}
            title="Import from Jellyfin or Plex"
            onPress={() => router.push("/owner/import")}
          />
          <ListRow icon={Server} title="Backups" onPress={() => router.push("/owner/backups")} />
        </>
      ) : null}
      <ListRow icon={Settings2} title="Server" onPress={() => router.push("/owner/server")} />
    </OwnerScreen>
  );
}
