/** F01–F14 · Player: a movie or an episode, full screen in landscape. */
import { Option } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { View } from "react-native";

import { PlayerScreen } from "@/components/player/player-screen";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { parseWatchParams } from "@/lib/routes";

export default function Watch() {
  const params = parseWatchParams(useLocalSearchParams());

  if (Option.isNone(params)) {
    return (
      <View className="flex-1 bg-bg">
        <CalmState
          icon={CircleAlert}
          title="Can't Play This"
          description="This link doesn't name something to play."
          actions={<Button label="Close" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  const { titleId, episodeId, fileId, start } = params.value;

  // Another title, episode, version, or start is another session: the player starts over.
  return <PlayerScreen key={[titleId, episodeId, fileId, start].join("|")} params={params.value} />;
}
