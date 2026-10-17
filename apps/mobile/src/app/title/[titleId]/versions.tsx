/**
 * D06 · Choose Version: the files of a movie, or of an episode with `episodeId`, best first. The
 * chosen one (from `fileId`, else the last played, else the best) shows its technical facts; Play
 * Selected Version plays it.
 */
import type { MediaFileId } from "@movies/contracts/ids";
import { MediaLabels, Versions } from "@movies/sdk/effect";
import { useCommandQuery } from "@movies/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, Clapperboard, Play } from "lucide-react-native";
import { useState } from "react";

import { episodeIdParam, fileIdParam, titleIdParam } from "@/components/title/route-params";
import { Sheet, leaveSheetFor } from "@/components/title/sheet";
import { defaultVersion } from "@/components/title/title-model";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { describeFailure } from "@/lib/failure";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";

export default function ChooseVersion() {
  const params = useLocalSearchParams<{ titleId: string; episodeId?: string; fileId?: string }>();
  const { profile } = useActiveProfile();
  const titleId = titleIdParam(params.titleId);
  const episodeId = episodeIdParam(params.episodeId);
  const [chosenId, setChosenId] = useState<MediaFileId | null>(fileIdParam(params.fileId));

  const versions = useCommandQuery(
    "titles.versions",
    titleId === null
      ? "skip"
      : episodeId === null
        ? { profileId: profile.id, titleId }
        : { profileId: profile.id, titleId, episodeId },
  );

  if (titleId === null) return <Sheet title="Choose Version" error="This title isn't here." />;

  const list = versions.status === "success" ? versions.data : [];
  const chosen = list.find((version) => version.id === chosenId) ?? defaultVersion(list);

  return (
    <Sheet
      title="Choose Version"
      loading={versions.status === "loading"}
      error={versions.status === "error" ? describeFailure(versions.error) : null}
    >
      {list.flatMap((version) => {
        const selected = version.id === chosen?.id;

        const row = (
          <ListRow
            key={version.id}
            icon={selected ? Check : Clapperboard}
            title={Versions.label(version)}
            detail={selected ? "Selected" : MediaLabels.sizeLabel(version.sizeBytes)}
            onPress={() => setChosenId(version.id)}
          />
        );

        return selected
          ? [
              row,
              <Text key={`${version.id}:detail`} variant="secondary" tone="muted">
                {Versions.detail(version)}
              </Text>,
            ]
          : [row];
      })}
      {chosen === undefined ? null : (
        <Button
          label="Play Selected Version"
          icon={Play}
          iconFilled
          onPress={() =>
            leaveSheetFor(
              watchHref({ titleId, episodeId: episodeId ?? undefined, fileId: chosen.id }),
            )
          }
        />
      )}
    </Sheet>
  );
}
