import { EpisodeId, TitleId } from "@movies/contracts/ids";
import { buttonVariants } from "@movies/ui/components/button";
import { CalmState } from "@movies/ui/components/calm-state";
import { cn } from "@movies/ui/lib/utils";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { RequireProfile, RequireSignedIn } from "@/session/guards";

const decodeTitleId = Schema.decodeSync(TitleId);

const WatchSearch = Schema.Struct({
  /** The episode to play; omit for a movie or a show's next episode. */
  episodeId: Schema.optionalKey(EpisodeId),
  /** `0` plays from the beginning instead of resuming. */
  start: Schema.optionalKey(Schema.Literal("0")),
});

/**
 * Playback of a movie or episode. The player arrives with the playback milestone; this route
 * already owns the URL Play and Resume link to: `/watch/<titleId>?episodeId=…&start=0`.
 */
export const Route = createFileRoute("/watch/$titleId")({
  params: {
    parse: (raw) => ({ titleId: decodeTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  validateSearch: Schema.toStandardSchemaV1(WatchSearch),
  head: () => ({ meta: [{ title: "Watch · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <RequireProfile>
        <WatchPage />
      </RequireProfile>
    </RequireSignedIn>
  ),
});

function WatchPage() {
  const { titleId } = Route.useParams();

  return (
    <div className="on-media flex min-h-svh items-center justify-center bg-dark-bg px-6">
      <CalmState
        title="The player is on its way"
        actions={
          <Link
            to="/title/$titleId"
            params={{ titleId }}
            className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
          >
            Back
          </Link>
        }
      />
    </div>
  );
}
