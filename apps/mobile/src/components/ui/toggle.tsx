/**
 * The iOS switch in Paper's colors (B03 Kids Profile): the hairline track when off, the accent
 * when on, and a white thumb.
 */
import { Switch } from "react-native";

import { useThemeColor } from "@/lib/theme-color";

/** Props for `Toggle`. */
export interface ToggleProps {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  /** What VoiceOver reads, such as `Kids Profile`. */
  readonly label: string;
  readonly disabled?: boolean;
}

/** An on/off switch. */
export function Toggle({ value, onValueChange, label, disabled = false }: ToggleProps) {
  const off = useThemeColor("--color-hairline");
  const on = useThemeColor("--color-accent");
  const thumb = useThemeColor("--color-on-accent");

  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      accessibilityLabel={label}
      disabled={disabled}
      trackColor={{ false: off, true: on }}
      ios_backgroundColor={off}
      thumbColor={thumb}
    />
  );
}
