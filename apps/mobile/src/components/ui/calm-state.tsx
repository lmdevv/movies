/**
 * A centered whole-screen state for failures and empty screens (A08 Server Unavailable, D08 File
 * Unavailable): an icon, a heading, one short line, and up to two actions. No colored stripes.
 */
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "./icon";
import { Text } from "./text";

/** Props for `CalmState`. */
export interface CalmStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}

/** A centered state with an optional way forward. */
export function CalmState({ icon, title, description, actions }: CalmStateProps) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-8">
      {icon === undefined ? null : <Icon icon={icon} tone="muted" size="state" />}
      <View className="items-center gap-2">
        <Text variant="heading" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text tone="muted" className="text-center">
            {description}
          </Text>
        )}
      </View>
      {actions === undefined ? null : <View className="w-full gap-3 pt-2">{actions}</View>}
    </View>
  );
}
