import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { PinPad } from "@/components/pin-pad";
import { useProfileEditor } from "@/components/profile-editor";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

export default function ConfirmProfilePin() {
  const { candidatePin, setCandidatePin, change } = useProfileEditor();
  const [pin, setPin] = useState("");
  const [mismatch, setMismatch] = useState(false);

  return (
    <Screen header={<NavHeader title="Confirm PIN" />}>
      <View className="gap-4 px-5 py-4">
        <View className="h-12" />
        <Text variant="subheading">Enter your PIN again.</Text>
        <PinPad
          value={pin}
          onChange={(next) => {
            setPin(next);
            setMismatch(false);
          }}
          onComplete={(value) => {
            setPin("");

            if (value !== candidatePin) {
              setMismatch(true);

              return;
            }

            change((current) => ({ ...current, pin: { kind: "set", pin: value } }));
            setCandidatePin(null);
            router.dismiss(2);
          }}
          message={mismatch ? { text: "PINs don’t match. Try again.", tone: "danger" } : null}
          label="Confirm PIN"
        />
      </View>
    </Screen>
  );
}
