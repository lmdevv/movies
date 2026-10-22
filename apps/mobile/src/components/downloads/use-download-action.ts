import { Check, Download } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { downloadIdOf, statusOf } from "@/lib/downloads/model";
import type { NewDownload } from "@/lib/downloads/model";
import { downloadHref } from "@/lib/routes";
import { useDownloadSettings } from "@/session/download-settings";
import { useDownloads } from "@/session/downloads";

/** What to download, before the quality is chosen. */
export type DownloadTarget = Omit<NewDownload, "quality">;

/** The row's text and what pressing it does. */
export interface DownloadAction {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string | undefined;
  /** Queues the download; returns the page to open instead when it is already queued or kept. */
  readonly press: () => string | null;
}

/** The Download row for `target`, or null while no account is signed in here. */
export const useDownloadAction = (target: DownloadTarget): DownloadAction | null => {
  const { engine, snapshot } = useDownloads();
  const settings = useDownloadSettings();

  if (engine === null || snapshot === null) return null;
  const id = downloadIdOf(target.profileId, target.titleId, target.episodeId);
  const existing = snapshot.store.downloads.find((download) => download.id === id);

  if (existing === undefined) {
    return {
      icon: Download,
      title: "Download",
      detail: undefined,
      press: () => {
        engine.add({ ...target, quality: settings.quality });

        return null;
      },
    };
  }

  return {
    icon: existing.phase === "ready" ? Check : Download,
    title: existing.phase === "ready" ? "Downloaded" : "Downloading",
    detail: existing.phase === "ready" ? undefined : statusOf(existing),
    press: () =>
      existing.phase === "noSpace"
        ? `${downloadHref(existing.id)}/storage-full`
        : downloadHref(existing.id),
  };
};
