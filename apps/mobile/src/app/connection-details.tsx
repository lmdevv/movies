/** A09 · Connection Details: the media and account servers typed separately. */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { connectManually, describeConnectFailure } from "@/lib/discovery";
import { useConnection } from "@/session/connection";

export default function ConnectionDetails() {
  const { connect } = useConnection();
  const [mediaUrl, setMediaUrl] = useState("");
  const [convexUrl, setConvexUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = mediaUrl.trim() !== "" && convexUrl.trim() !== "" && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await connectManually(mediaUrl, convexUrl);

    setBusy(false);

    if (result.ok) connect(result.connection);
    else setError(describeConnectFailure(result.failure));
  };

  return (
    <Screen scroll header={<NavHeader title="Connection Details" />}>
      <TextField
        label="Media server"
        placeholder="https://cinema.home"
        value={mediaUrl}
        onChangeText={setMediaUrl}
        autoCapitalize="none"
        keyboardType="url"
        className="mt-8"
      />
      <TextField
        label="Account server"
        placeholder="https://accounts.cinema.home"
        value={convexUrl}
        onChangeText={setConvexUrl}
        error={error}
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
