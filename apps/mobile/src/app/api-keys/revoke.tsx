import { ApiKeyId } from "@movies/contracts/ids";
import { useCommand } from "@movies/sdk/react";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { KeyRound } from "lucide-react-native";

import { ConfirmSheet } from "@/components/settings/confirm-sheet";

const decodeApiKeyId = Schema.decodeUnknownOption(ApiKeyId);

export default function RevokeKey() {
  const params = useLocalSearchParams<{ apiKeyId: string; name?: string }>();
  const apiKeyId = Option.getOrNull(decodeApiKeyId(params.apiKeyId));
  const revoke = useCommand("apiKeys.revoke");

  return (
    <ConfirmSheet
      title="Revoke this key?"
      description={`${params.name ?? "This key"} will lose access.`}
      action="Revoke Key"
      icon={KeyRound}
      onConfirm={async () => {
        if (apiKeyId === null) throw new Error("This key can’t be found. Go back and try again.");
        await revoke({ apiKeyId });
      }}
    />
  );
}
