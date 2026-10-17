/** B10 · Maximum Rating: the highest rating the profile sees; the check keeps the choice. */
import { router } from "expo-router";
import { Check } from "lucide-react-native";
import { useState } from "react";

import { useProfileEditor } from "@/components/profile-editor";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { ratingChoices } from "@/lib/profile-draft";

export default function MaximumRating() {
  const { draft, change } = useProfileEditor();
  const [maxAgeRating, setMaxAgeRating] = useState(draft.maxAgeRating);

  return (
    <Screen
      scroll
      header={
        <NavHeader
          title="Maximum Rating"
          trailing={
            <IconButton
              icon={Check}
              label="Done"
              onPress={() => {
                change((current) => ({ ...current, maxAgeRating }));
                router.back();
              }}
            />
          }
        />
      }
    >
      {ratingChoices(draft.kids).map((choice) => {
        const selected = choice.maxAgeRating === maxAgeRating;

        return (
          <ListRow
            key={choice.label}
            title={choice.label}
            {...(selected ? { detail: "Selected" } : {})}
            onPress={() => setMaxAgeRating(choice.maxAgeRating)}
          />
        );
      })}
      <Text variant="secondary" tone="muted">
        Applies to browsing, search, and playback.
      </Text>
    </Screen>
  );
}
