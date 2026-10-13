import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { TitleGridPage } from "@/components/browse/title-grid-page";

const Genre = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(100));

const decodeGenre = Schema.decodeSync(Genre);

export const Route = createFileRoute("/_app/genre/$genre")({
  params: {
    parse: (raw) => ({ genre: decodeGenre(raw.genre) }),
    stringify: (params) => ({ genre: params.genre }),
  },
  head: ({ params }) => ({ meta: [{ title: `${params.genre} · [movies]` }] }),
  component: GenrePage,
});

/** Every movie and show of one genre the profile may see, with the grid's filters. */
function GenrePage() {
  const { genre } = Route.useParams();

  // A new genre starts the grid over.
  return <TitleGridPage key={genre} genre={genre} heading={genre} />;
}
