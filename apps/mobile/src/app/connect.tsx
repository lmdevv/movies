/** A02 · Connect to Server: type the server's address; A08 shows when nothing answers. */
import { router } from "expo-router";
import { Link2 } from "lucide-react-native";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { describeConnectFailure, discoverServer } from "@/lib/discovery";
import { useConnection } from "@/session/connection";

export default function Connect() {
  const { connect } = useConnection();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = address.trim() !== "" && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await discoverServer(address);

    setBusy(false);

    if (result.ok) connect(result.connection);
    else setError(describeConnectFailure(result.failure));
  };

  return (
    <Screen scroll header={<NavHeader title="Connect to Server" />}>
      <TextField
        label="Server address"
        placeholder="https://cinema.home"
        value={address}
        onChangeText={(text) => {
          setAddress(text);
          setError(null);
        }}
        error={error}
        autoCapitalize="none"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        autoFocus
        onSubmitEditing={() => void submit()}
        className="mt-12"
      />
      <Button
        label="Continue"
        busy={busy}
        disabled={address.trim() === ""}
        onPress={() => void submit()}
      />
      <ListRow
        icon={Link2}
        title="Enter Connection Details"
        onPress={() => router.push("/connection-details")}
      />
    </Screen>
  );
}
