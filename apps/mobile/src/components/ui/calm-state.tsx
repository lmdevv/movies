/**
 * A centered whole-screen state for failures and endings (A07 Invite Expired, A08 Server
 * Unavailable, A10 Code Expired, D08 File Unavailable): a glyph in a round surface badge, a 28pt
 * heading, one short muted line, and up to two actions 24pt below. No colored stripes.
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
    <View className="flex-1 justify-center gap-6 px-5 pb-16">
      <View className="items-center gap-4 py-6">
        {icon === undefined ? null : (
          <View className="size-18 items-center justify-center rounded-pill bg-surface">
            <Icon icon={icon} size="badge" />
          </View>
        )}
        <Text variant="title" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text tone="muted" className="text-center">
            {description}
          </Text>
        )}
      </View>
      {actions === undefined ? null : <View className="w-full gap-4">{actions}</View>}
    </View>
  );
}
