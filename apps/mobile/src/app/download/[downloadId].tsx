/**
 * A download's page. Ready, it is H17: the title in the header, the picture, the movie's or
 * episode's name and facts, Play Download, `Downloaded · 720p · 842 MB`, and Remove Download.
 * Otherwise it is the row as C19 shows it, under the Downloads header: interrupted (H19), the
 * short danger line with Retry Download and Cancel Download; still on its way, its transfer line
 * and Cancel Download; stopped for space, Retry Download (which checks again) and Cancel.
 */
import { router, useLocalSearchParams } from "expo-router";
import { Ellipsis, Play, RotateCw, Trash2 } from "lucide-react-native";
import { ScrollView, View } from "react-native";

import { DownloadRow, useDownloadPicture } from "@/components/downloads/download-row";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { IconButton } from "@/components/ui/icon-button";
import { Image } from "@/components/ui/image";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { factsOf, keptLine } from "@/lib/downloads/model";
import type { DownloadRecord } from "@/lib/downloads/model";
import { DOWNLOADS_HREF, downloadHref, playDownloadHref } from "@/lib/routes";
import type { DownloadEngine } from "@/session/download-engine";
import { useDownload } from "@/session/downloads";

/** H17: a kept download. */
function KeptDownload({
  engine,
  download,
}: {
  readonly engine: DownloadEngine;
  readonly download: DownloadRecord;
}) {
  const picture = useDownloadPicture(engine, download);
  const href = downloadHref(download.id);

  return (
    <Screen
      edges={["top"]}
      header={
        <NavHeader
          title={download.titleName}
          fallback={DOWNLOADS_HREF}
          trailing={
            <IconButton
              icon={Ellipsis}
              label="More"
              onPress={() => router.push(`${href}/actions`)}
            />
          }
        />
      }
    >
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <View className="aspect-video w-full overflow-hidden rounded-card bg-surface-raised">
          {picture === undefined ? null : (
            <Image source={{ uri: picture }} contentFit="cover" className="size-full" />
          )}
        </View>
        <Text variant="title" accessibilityRole="header">
          {download.episodeName ?? download.titleName}
        </Text>
        <Text variant="secondary" tone="muted">
          {factsOf(download)}
        </Text>
        <Button
          label="Play Download"
          icon={Play}
          iconFilled
          onPress={() => router.push(playDownloadHref(download))}
        />
        <Text variant="secondary" tone="muted">
          {keptLine(download)}
        </Text>
        <ListRow
          icon={Trash2}
          title="Remove Download"
          onPress={() => router.push(`${href}/remove`)}
        />
      </ScrollView>
    </Screen>
  );
}

/** H19 and the other states before a download is kept. */
function PendingDownload({
  engine,
  download,
}: {
  readonly engine: DownloadEngine;
  readonly download: DownloadRecord;
}) {
  const stopped = download.phase === "interrupted" || download.phase === "noSpace";

  const cancel = () => {
    void engine.remove(download.id);
    router.back();
  };

  return (
    <Screen
      edges={["top"]}
      header={
        <NavHeader
          title="Downloads"
          fallback={DOWNLOADS_HREF}
          trailing={
            <IconButton
              icon={Ellipsis}
              label="More"
              onPress={() => router.push(`${downloadHref(download.id)}/actions`)}
            />
          }
        />
      }
    >
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <DownloadRow engine={engine} download={download} />
        {download.error === null ? null : (
          <Text tone="danger" accessibilityLiveRegion="polite">
            {download.error}
          </Text>
        )}
        {stopped ? (
          <Button
            label="Retry Download"
            icon={RotateCw}
            onPress={() => engine.retry(download.id)}
          />
        ) : null}
        <Button label="Cancel Download" variant="secondary" onPress={cancel} />
      </ScrollView>
    </Screen>
  );
}

export default function DownloadPage() {
  const params = useLocalSearchParams<{ downloadId: string }>();
  const found = useDownload(params.downloadId);

  if (found === null) {
    return (
      <Screen header={<NavHeader title="Downloads" fallback={DOWNLOADS_HREF} />}>
        <CalmState title="Not Downloaded" description="This download was removed." />
      </Screen>
    );
  }

  return found.download.phase === "ready" ? (
    <KeptDownload engine={found.engine} download={found.download} />
  ) : (
    <PendingDownload engine={found.engine} download={found.download} />
  );
}
