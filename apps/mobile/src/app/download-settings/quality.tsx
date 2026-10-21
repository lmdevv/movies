/** H18's Video Quality sheet: Standard or High (`Larger Files`) for new downloads. */
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { ListRow } from "@/components/ui/list-row";
import { DOWNLOAD_QUALITY_OPTIONS } from "@/lib/downloads/settings";
import { updateDownloadSettings, useDownloadSettings } from "@/session/download-settings";

export default function DownloadQuality() {
  const settings = useDownloadSettings();
  const exit = useSheetExit();

  return (
    <Sheet title="Video Quality" exit={exit}>
      {DOWNLOAD_QUALITY_OPTIONS.map((option) => {
        const selected = option.id === settings.quality;

        return (
          <ListRow
            key={option.id}
            title={option.label}
            detail={selected ? "Selected" : (option.note ?? undefined)}
            selected={selected}
            onPress={() => {
              updateDownloadSettings({ quality: option.id });
              exit.close();
            }}
          />
        );
      })}
    </Sheet>
  );
}
