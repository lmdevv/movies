/**
 * A browse screen with nothing to show (C06 My List empty, C12 empty library, E04 no results): a
 * glyph in a 72pt circle, a 28pt heading, an optional line, and up to one way forward.
 */
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";

/** Props for `EmptyState`. */
export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

/** A centered empty state. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <View className="gap-4 px-5 pt-30">
      <View className="items-center gap-4 py-6">
        <View className="size-18 items-center justify-center rounded-pill bg-surface">
          <Icon icon={icon} size="badge" />
        </View>
        <Text variant="title" className="text-center" accessibilityRole="header">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text tone="muted" className="text-center">
            {description}
          </Text>
        )}
      </View>
      {action}
    </View>
  );
}
