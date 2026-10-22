import type { ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Edge } from "react-native-safe-area-context";

/** Props for `Screen`. */
export interface ScreenProps {
  readonly children: ReactNode;
  /** Scrolls the content and avoids the keyboard, for forms. */
  readonly scroll?: boolean;
  readonly edges?: ReadonlyArray<Edge>;
  readonly header?: ReactNode;
  readonly contentClassName?: string;
}

/** A full-screen page. */
export function Screen({
  children,
  scroll = false,
  edges = ["top", "bottom"],
  header,
  contentClassName,
}: ScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-1 bg-bg"
      style={{
        paddingTop: edges.includes("top") ? insets.top : 0,
        paddingBottom: edges.includes("bottom") ? insets.bottom : 0,
      }}
    >
      {header}
      {scroll ? (
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerClassName={`grow px-5 py-4 gap-4 ${contentClassName ?? ""}`}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <View className={`flex-1 ${contentClassName ?? ""}`}>{children}</View>
      )}
    </View>
  );
}
