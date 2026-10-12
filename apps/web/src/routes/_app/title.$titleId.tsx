import { TitleId } from "@movies/contracts/ids";
import { useCommandQuery } from "@movies/sdk/react";
import { buttonVariants } from "@movies/ui/components/button";
import { CalmState } from "@movies/ui/components/calm-state";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { HeroSkeleton } from "@/components/browse/skeletons";
import { TitleDetailView } from "@/components/browse/title-detail";
import { describeFailure, isFailure } from "@/lib/failure";
import { usePhone } from "@/lib/use-phone";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

const decodeTitleId = Schema.decodeSync(TitleId);

export const Route = createFileRoute("/_app/title/$titleId")({
  params: {
    parse: (raw) => ({ titleId: decodeTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  staticData: { hero: true, phoneTitle: false },
  component: TitlePage,
});

/** A movie's or show's page, live. Titles hidden from a kids profile read as not found. */
function TitlePage() {
  const { titleId } = Route.useParams();
  const { profile } = useActiveProfile();
  const scopes = useScopes();
  const phone = usePhone();
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId });

  if (title.status === "loading") return <HeroSkeleton />;

  if (title.status === "error") {
    const missing = isFailure(title.error, "NotFound");

    return (
      <div className="flex min-h-[70svh] items-center justify-center px-6 md:pt-17">
        <CalmState
          title={missing ? "This title isn't here" : "This title didn't load"}
          description={missing ? undefined : describeFailure(title.error)}
          actions={
            <Link to="/" className={buttonVariants({ variant: "subtle" })}>
              Go home
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <title>{`${title.data.name} · [movies]`}</title>
      <TitleDetailView
        title={title.data}
        profileId={profile.id}
        canManage={scopes.has("manage")}
        phone={phone}
      />
    </>
  );
}
