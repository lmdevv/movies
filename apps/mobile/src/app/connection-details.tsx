/** A09 · Connection Details: the media and account servers typed separately. */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { connectManually, describeConnectFailure, normalizeServerUrl } from "@/lib/discovery";
import type { ConnectFailure } from "@/lib/discovery";
import { useConnection } from "@/session/connection";

export default function ConnectionDetails() {
  const { connect } = useConnection();
  const [mediaUrl, setMediaUrl] = useState("");
  const [convexUrl, setConvexUrl] = useState("");
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = mediaUrl.trim() !== "" && convexUrl.trim() !== "" && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    const result = await connectManually(mediaUrl, convexUrl);

    setBusy(false);

    if (result.ok) connect(result.connection);
    else setFailure(result.failure);
  };

  // A failure shows under the field it is about, and editing either field clears it.
  const mediaError =
    failure === "unreachable" || (failure === "invalid" && normalizeServerUrl(mediaUrl) === null)
      ? describeConnectFailure(failure)
      : null;

  const convexError =
    failure === null || mediaError !== null ? null : describeConnectFailure(failure);

  return (
    <Screen scroll header={<NavHeader title="Connection Details" />}>
      <TextField
        label="Media server"
        placeholder="https://cinema.home"
        value={mediaUrl}
        onChangeText={(text) => {
          setMediaUrl(text);
          setFailure(null);
        }}
        error={mediaError}
        autoCapitalize="none"
        keyboardType="url"
        className="mt-8"
      />
      <TextField
        label="Account server"
        placeholder="https://accounts.cinema.home"
        value={convexUrl}
        onChangeText={(text) => {
          setConvexUrl(text);
          setFailure(null);
        }}
        error={convexError}
        autoCapitalize="none"
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button
        label="Connect"
        busy={busy}
        disabled={mediaUrl.trim() === "" || convexUrl.trim() === ""}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
