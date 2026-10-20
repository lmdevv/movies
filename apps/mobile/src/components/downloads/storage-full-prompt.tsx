/**
 * Opens H21 · Storage Full when a download stops for lack of space on this iPhone, once for each
 * time it does, wherever people are in the app.
 */
import { router } from "expo-router";
import { useEffect, useRef } from "react";

import { downloadHref } from "@/lib/routes";
import { useDownloads } from "@/session/downloads";

/** Watches the downloads and opens H21 for one that just ran out of space. */
export function StorageFullPrompt() {
  const { snapshot } = useDownloads();
  // The downloads already out of space when last seen, so each is announced once; null before the
  // downloads loaded, so ones that ran out of space before this launch are not announced again.
  const seen = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    const full = new Set(
      (snapshot?.store.downloads ?? [])
        .filter((download) => download.phase === "noSpace")
        .map((download) => download.id),
    );

    const before = seen.current;

    seen.current = snapshot === null ? null : full;

    if (before === null) return;
    const fresh = [...full].find((id) => !before.has(id));

    if (fresh !== undefined) router.push(`${downloadHref(fresh)}/storage-full`);
  }, [snapshot]);

  return null;
}
