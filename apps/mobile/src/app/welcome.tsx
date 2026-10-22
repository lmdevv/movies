import { router } from "expo-router";
import { View } from "react-native";

import welcomeArt from "../../assets/images/welcome.jpg";

import { Button } from "@/components/ui/button";
import { Image } from "@/components/ui/image";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

export default function Welcome() {
  return (
    <Screen>
      <View className="h-16 flex-row items-center px-5">
        <Text variant="largeTitle" accessibilityRole="header">
          [movies]
        </Text>
      </View>
      <View className="gap-4 px-5 py-4">
        <View className="h-20" />
        <Image
          source={welcomeArt}
          contentFit="cover"
          accessibilityIgnoresInvertColors
          className="h-47.5 w-full rounded-card"
        />
        <Text variant="display">{"Your cinema.\nEverywhere."}</Text>
        <View className="h-4" />
        <Button label="Connect to Server" onPress={() => router.push("/connect")} />
        <Button
          label="Open an Invite"
          variant="secondary"
          onPress={() => router.push("/open-invite")}
        />
      </View>
    </Screen>
  );
}
