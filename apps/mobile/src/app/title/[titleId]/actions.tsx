/**
 * D10 · A title's More sheet: add to or remove from My List, play from the beginning when resuming,
 * mark the movie or the whole show watched or unwatched, and share its page.
 */
import type { TitleDetail } from "@movies/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Check, EyeOff, Minus, Plus, RotateCcw, Share as ShareIcon } from "lucide-react-native";
import { Share } from "react-native";

import { titleIdParam } from "@/components/title/route-params";
import { Sheet, leaveSheetFor } from "@/components/title/sheet";
import { isWatched, playAction } from "@/components/title/title-model";
import { useMyListToggle, useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

/** The actions of one loaded title. */
function TitleActions({ title }: { readonly title: TitleDetail }) {
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const myList = useMyListToggle(profile.id, title.id, title.inMyList);
  const markWatched = useCommand("history.markWatched");
  const markUnwatched = useCommand("history.markUnwatched");
  const mark = useRunner();
  const watched = isWatched(title);
  const play = playAction(title);

  const toggleWatched = async () => {
    const args = { profileId: profile.id, titleId: title.id };
    const done = await mark.run(() => (watched ? markUnwatched(args) : markWatched(args)));

    if (done) router.back();
  };

  const toggleList = async () => {
    if (await myList.toggle()) router.back();
  };

  const share = async () => {
    // Whether shared or dismissed, the sheet's job is done.
    await Share.share({ message: title.name, url: `${mediaUrl}/title/${title.id}` }).catch(
      () => undefined,
    );
    router.back();
  };

  return (
    <Sheet title={title.name} error={myList.error ?? mark.error}>
      <ListRow
        icon={myList.inList ? Minus : Plus}
        title={myList.inList ? "Remove from My List" : "Add to My List"}
        onPress={() => void toggleList()}
      />
      {play.resuming && title.available ? (
        <ListRow
          icon={RotateCcw}
          title="Play from Beginning"
          onPress={() =>
            leaveSheetFor(
              watchHref({ titleId: title.id, episodeId: play.episodeId, start: "beginning" }),
            )
          }
        />
      ) : null}
      <ListRow
        icon={watched ? EyeOff : Check}
        title={watched ? "Mark as Unwatched" : "Mark as Watched"}
        disabled={mark.busy}
        onPress={() => void toggleWatched()}
      />
      <ListRow icon={ShareIcon} title="Share" onPress={() => void share()} />
    </Sheet>
  );
}

export default function TitleActionsSheet() {
  const params = useLocalSearchParams<{ titleId: string }>();
  const { profile } = useActiveProfile();
  const titleId = titleIdParam(params.titleId);

  const title = useCommandQuery(
    "titles.get",
    titleId === null ? "skip" : { profileId: profile.id, titleId },
  );

  if (titleId === null) return <Sheet title="Title" error="This title isn't here." />;

  if (title.status !== "success") {
    return (
      <Sheet
        title="Title"
        loading={title.status === "loading"}
        error={title.status === "error" ? describeFailure(title.error) : null}
      />
    );
  }

  return <TitleActions title={title.data} />;
}
