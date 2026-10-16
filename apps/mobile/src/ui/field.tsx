/**
 * A labelled text field as the sign-in screens draw it: a label (with an optional action on the
 * right), a 52pt filled box, and a short danger line under it when the value was refused.
 */
import type { ReactNode, Ref } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { TextInputInstance, TextInputProps } from "react-native";

import { colors, overlay, radius, space, system, type } from "@/theme/tokens";

import { ErrorLine } from "./error-line";
import { Text } from "./text";

/** Props for `Field`. */
interface FieldProps extends Omit<TextInputProps, "style" | "placeholderTextColor"> {
  readonly label: string;
  /** Something on the label's right, such as a link. */
  readonly labelAccessory?: ReactNode;
  /** A glyph before the text. */
  readonly icon?: ReactNode;
  /** A control after the text, such as the password eye. */
  readonly accessory?: ReactNode;
  /** The refusal to show under the field; it also tints the box. */
  readonly error?: string | null;
  /** `mono` for server addresses and codes. */
  readonly font?: "sans" | "mono";
  readonly inputRef?: Ref<TextInputInstance>;
}

/** A labelled single-line text field. */
export function Field({
  label,
  labelAccessory,
  icon,
  accessory,
  error = null,
  font = "sans",
  inputRef,
  ...input
}: FieldProps) {
  const treatment = font === "mono" ? type.mono : type.body;

  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text variant="label" color={colors.textMuted}>
          {label}
        </Text>
        {labelAccessory}
      </View>
      <View
        style={[
          styles.box,
          accessory === undefined ? null : styles.boxWithAccessory,
          error === null ? null : styles.boxError,
        ]}
      >
        {icon}
        <TextInput
          {...input}
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={system.placeholder}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          style={[
            styles.input,
            {
              fontFamily: treatment.family,
              fontSize: treatment.size,
              lineHeight: treatment.lineHeight,
            },
          ]}
        />
        {accessory}
      </View>
      {error === null ? null : <ErrorLine message={error} />}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space[2] },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  box: {
    height: 52,
    borderRadius: radius.field,
    backgroundColor: system.fill,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: space[4],
  },
  boxWithAccessory: { paddingRight: 6 },
  boxError: {
    backgroundColor: overlay.dangerFill,
    boxShadow: `inset 0 0 0 1px ${overlay.dangerBorder}`,
  },
  input: { flex: 1, height: "100%", color: colors.text, padding: 0 },
});
