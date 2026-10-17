/** The profile avatar at the top right of Home (C01): opens You. */
import { router } from "expo-router";
import { UserRound } from "lucide-react-native";

import { IconButton } from "@/components/ui/icon-button";

/** The avatar button, glass over artwork and raised elsewhere. */
export function ProfileButton({ overMedia }: { readonly overMedia: boolean }) {
  return (
    <IconButton
      icon={UserRound}
      label="Profile and Settings"
      variant={overMedia ? "glass" : "raised"}
      onPress={() => router.push("/you")}
    />
  );
}
