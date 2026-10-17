/** B12 · Set Profile PIN: four digits, then Confirm PIN asks for them again. */
import { useState } from "react";
import { View } from "react-native";

import { PinPad } from "@/components/pin-pad";
import { useProfileEditor } from "@/components/profile-editor";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

export default function SetProfilePin() {
  const { setCandidatePin, open } = useProfileEditor();
  const [pin, setPin] = useState("");

  return (
    <Screen header={<NavHeader title="Set Profile PIN" />}>
      <View className="gap-4 px-5 py-4">
        <View className="h-12" />
        <Text variant="subheading">Choose a four-digit PIN.</Text>
        <PinPad
          value={pin}
          onChange={setPin}
          onComplete={(value) => {
            setCandidatePin(value);
            setPin("");
            open("confirm-pin");
          }}
          label="New PIN"
        />
      </View>
    </Screen>
  );
}
