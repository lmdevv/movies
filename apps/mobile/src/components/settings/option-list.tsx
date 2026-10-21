/**
 * A preference picker (H22 Appearance, H26 Streaming Quality, H27 Mobile Data, and the audio and
 * subtitle languages): one row per choice, the chosen one marked `Selected`. Choosing saves at once.
 */
import { View } from "react-native";

import { ListRow } from "@/components/ui/list-row";
import type { PreferenceOption } from "@/lib/preferences";

/** Props for `OptionList`. */
export interface OptionListProps<A> {
  readonly options: ReadonlyArray<PreferenceOption<A>>;
  readonly value: A;
  readonly onChoose: (value: A) => void;
  /** Rows sit 16pt apart on full screens and touch in sheets. */
  readonly spaced?: boolean;
}

/** The choices of one preference. */
export function OptionList<A>({ options, value, onChoose, spaced = true }: OptionListProps<A>) {
  return (
    <View className={spaced ? "gap-4" : ""}>
      {options.map((option) => {
        const chosen = option.value === value;

        return (
          <ListRow
            key={option.label}
            title={option.label}
            {...(chosen
              ? { detail: "Selected" }
              : option.detail === undefined
                ? {}
                : { detail: option.detail })}
            selected={chosen}
            onPress={() => onChoose(option.value)}
          />
        );
      })}
    </View>
  );
}
