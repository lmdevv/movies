/**
 * A profile's tile (B01): a raised square with the name's initial, or a TV glyph for Kids
 * profiles. Avatar keys from other clients draw the same tile.
 */
import type { Profile } from "@movies/contracts/models/profiles";
import { Tv } from "lucide-react-native";
import { View } from "react-native";

import { Icon } from "./ui/icon";
import { Text } from "./ui/text";

/** Props for `ProfileAvatar`. */
export interface ProfileAvatarProps {
  readonly profile: Pick<Profile, "name" | "kids" | "avatar">;
  readonly size?: "large" | "small";
}

/** A profile's avatar tile. */
export function ProfileAvatar({ profile, size = "large" }: ProfileAvatarProps) {
  const large = size === "large";

  return (
    <View
      className={`items-center justify-center bg-surface-raised ${
        large ? "size-28 rounded-card" : "size-9 rounded-control"
      }`}
    >
      {profile.kids ? (
        <Icon icon={Tv} size={large ? "tile" : "inline"} />
      ) : (
        <Text variant={large ? "hero" : "labelStrong"}>
          {profile.name.trim().charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}
