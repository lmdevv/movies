/**
 * The Downloads tab's content: C19 · Downloads, the profile's downloads, or C20 · Downloads ·
 * Empty, whose Browse Library returns to Home.
 */
import { router } from "expo-router";

import { DownloadsList } from "./downloads-list";

const browse = () => router.navigate("/");

/** What the Downloads tab shows. */
export function DownloadsTab() {
  return <DownloadsList chrome="native" empty={{ label: "Browse Library", onPress: browse }} />;
}
