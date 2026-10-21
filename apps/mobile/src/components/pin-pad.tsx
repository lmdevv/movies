/**
 * The PIN keypad from B05, B06, B12, and B13: four 14pt dots, an optional line under them, and a
 * 3×4 grid of 72×56 keys. Dots fill as digits arrive and turn danger red after a wrong PIN.
 */
import * as Haptics from "expo-haptics";
import { Delete } from "lucide-react-native";
import { useEffect } from "react";
import { AccessibilityInfo, Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { KEYPAD_ROWS, PIN_LENGTH, pressKey } from "@/lib/pin";
import type { PinKey } from "@/lib/pin";

/** Props for `PinPad`. */
export interface PinPadProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Called once the fourth digit is in. */
  readonly onComplete?: (pin: string) => void;
  /** A short line under the dots: a danger line after a wrong PIN, or a muted one. */
  readonly message?: { readonly text: string; readonly tone: "danger" | "muted" } | null;
  /** Ignores keys, such as while a PIN is checked or the profile is locked out. */
  readonly disabled?: boolean;
  /** What VoiceOver calls the dots, such as `Alex's PIN`. */
  readonly label: string;
}

/** The four PIN dots alone, for B07 where the keypad is gone. */
export function PinDots({
  filled,
  wrong,
  label,
}: {
  readonly filled: number;
  readonly wrong: boolean;
  readonly label: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityValue={{ text: `${filled} of ${PIN_LENGTH} digits` }}
      className="flex-row justify-center gap-6 py-5"
    >
      {Array.from({ length: PIN_LENGTH }, (_, index) => (
        <View
          key={index}
          className={`size-3.5 rounded-pill ${
            wrong ? "bg-danger" : index < filled ? "bg-text" : "bg-surface-raised"
          }`}
        />
      ))}
    </View>
  );
}

function Key({
  pinKey,
  disabled,
  onPress,
}: {
  readonly pinKey: PinKey | null;
  readonly disabled: boolean;
  readonly onPress: (key: PinKey) => void;
}) {
  if (pinKey === null) return <View className="h-14 w-18" />;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pinKey === "delete" ? "Delete" : pinKey}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(pinKey);
      }}
      className={`h-14 w-18 items-center justify-center rounded-pill active:bg-surface-raised ${
        disabled ? "opacity-40" : ""
      }`}
    >
      {pinKey === "delete" ? (
        <Icon icon={Delete} size="large" />
      ) : (
        <Text variant="keypad">{pinKey}</Text>
      )}
    </Pressable>
  );
}

/** Four PIN dots and the keypad. */
export function PinPad({
  value,
  onChange,
  onComplete,
  message = null,
  disabled = false,
  label,
}: PinPadProps) {
  const line = message?.text;

  // iOS has no live regions: VoiceOver hears the line when it appears.
  useEffect(() => {
    if (line !== undefined) AccessibilityInfo.announceForAccessibility(line);
  }, [line]);

  const press = (key: PinKey) => {
    const next = pressKey(value, key);

    if (next === value) return;
    onChange(next);

    if (next.length === PIN_LENGTH && key !== "delete") onComplete?.(next);
  };

  return (
    <View className="gap-4">
      <PinDots
        filled={value.length}
        wrong={message?.tone === "danger" && value === ""}
        label={label}
      />
      {message === null ? null : (
        <Text variant="secondary" tone={message.tone} className="text-center">
          {message.text}
        </Text>
      )}
      {KEYPAD_ROWS.map((row, rowIndex) => (
        <View key={rowIndex} className="w-full flex-row justify-around">
          {row.map((pinKey, keyIndex) => (
            <Key
              key={pinKey ?? `blank-${keyIndex}`}
              pinKey={pinKey}
              disabled={disabled}
              onPress={press}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
