/** H22 · Appearance: the sheet that switches between the system's theme, light, and dark. */
import { APPEARANCE_OPTIONS } from "@/components/settings/appearance-options";
import { OptionList } from "@/components/settings/option-list";
import { Sheet } from "@/components/title/sheet";
import { updatePreferences, usePreferences } from "@/session/preferences";

export default function AppearanceSheet() {
  const { appearance } = usePreferences();

  // The sheet stays open, so the new theme shows behind it at once.
  return (
    <Sheet title="Appearance">
      <OptionList
        options={APPEARANCE_OPTIONS}
        value={appearance}
        onChoose={(next) => updatePreferences({ appearance: next })}
      />
    </Sheet>
  );
}
