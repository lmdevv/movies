/** The Movies tab's stack: the tab and its Sort, Filter, and Genres sheets, sharing its filters. */
import { BrowseStack } from "@/components/browse/browse-stack";

export default function MoviesLayout() {
  return <BrowseStack kind="movie" />;
}
