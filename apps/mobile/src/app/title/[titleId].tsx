/** D01 · Title detail. */
import { TitleId } from "@movies/contracts/ids";
import { useCommandQuery } from "@movies/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Play } from "lucide-react-native";
import { Schema } from "effect";

import { Button } from "@/components/ui/button";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useActiveProfile } from "@/session/active-profile";

const decodeTitleId = Schema.decodeUnknownSync(TitleId);

export default function Title() {
  const { titleId } = useLocalSearchParams<{ titleId: string }>();
  const { profile } = useActiveProfile();
  const id = decodeTitleId(titleId);
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId: id });

  return (
    <Screen scroll header={<NavHeader />}>
      {title.status === "success" ? (
        <>
          <Text variant="largeTitle">{title.data.name}</Text>
          <Text tone="muted">{title.data.overview ?? ""}</Text>
          <Button label="Play" icon={Play} iconFilled onPress={() => router.push(`/watch/${id}`)} />
        </>
      ) : null}
    </Screen>
  );
}
