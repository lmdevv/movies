/**
 * Sign in (A2) and its wrong-password state (A2b): email and password through the SDK, with the
 * server's refusal under the password. The pill at the top names the server and opens Connect to
 * change it.
 */
import { describeFailure } from "@movies/sdk/failure";
import { useAuth } from "@movies/sdk/react";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import type { TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Artwork } from "@/art/artwork-kit";
import { useDevice } from "@/device/device-state";
import { PAGE_INSET, black, colors, opacity, radius, space, system } from "@/theme/tokens";
import { PrimaryButton, SecondaryButton } from "@/ui/button";
import { Field } from "@/ui/field";
import { Glass } from "@/ui/glass";
import { ChevronDownIcon, EyeIcon, EyeOffIcon, ICON_STROKE, SmartphoneIcon } from "@/ui/icons";
import { BlankScreen } from "@/ui/screen";
import { Text } from "@/ui/text";

/** Paper's scrim over the backdrop: the art fades to black above the form. */
const SCRIM = {
  colors: [black(0.25), black(0.45), black(1)],
  locations: [0, 0.45, 0.96],
} as const;

export default function SignIn() {
  const { status } = useAuth();

  if (status === "loading") return <BlankScreen />;

  if (status === "signedIn") return <Redirect href="/" />;

  return <SignInForm />;
}

function SignInForm() {
  const router = useRouter();
  const { top } = useSafeAreaInsets();
  const { server } = useDevice();
  const { signInWithPassword } = useAuth();
  const password = useRef<TextInputInstance>(null);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const host = server === null ? "" : new URL(server.mediaUrl).host;

  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);

    try {
      await signInWithPassword({ flow: "signIn", email: email.trim(), password: secret });
      router.replace("/");
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Artwork name="dune" style={styles.backdrop} />
      <LinearGradient
        colors={SCRIM.colors}
        locations={SCRIM.locations}
        style={styles.scrim}
        pointerEvents="none"
      />
      <View style={[styles.serverRow, { paddingTop: top + 4 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Server ${host}. Change server`}
          onPress={() => router.push("/connect")}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Glass interactive radius={radius.pill} style={styles.serverPill}>
            <View style={styles.online} />
            <Text variant="monoLabel">{host}</Text>
            <ChevronDownIcon size={14} color={colors.textMuted} strokeWidth={2} />
          </Glass>
        </Pressable>
      </View>
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text variant="largeTitle" accessibilityRole="header" style={styles.title}>
          Welcome back.
        </Text>
        <View style={styles.fields}>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => password.current?.focus()}
          />
          <Field
            label="Password"
            inputRef={password}
            value={secret}
            onChangeText={(text) => {
              setSecret(text);
              setError(null);
            }}
            error={error}
            secureTextEntry={!revealed}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            accessory={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={revealed ? "Hide password" : "Show password"}
                onPress={() => setRevealed((shown) => !shown)}
                style={styles.eye}
              >
                {revealed ? (
                  <EyeOffIcon size={20} color={system.glyph} strokeWidth={ICON_STROKE} />
                ) : (
                  <EyeIcon size={20} color={system.glyph} strokeWidth={ICON_STROKE} />
                )}
              </Pressable>
            }
          />
        </View>
        <View style={styles.actions}>
          <PrimaryButton label="Sign in" pending={pending} onPress={() => void submit()} />
          <SecondaryButton
            label="Use a code from another device"
            icon={<SmartphoneIcon size={18} color={colors.text} strokeWidth={ICON_STROKE} />}
            onPress={() => router.push("/sign-in/code")}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: -60,
    width: 510,
    height: 400,
    borderRadius: radius.art,
    opacity: 0.8,
  },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, height: 420 },
  serverRow: { flexDirection: "row", paddingHorizontal: PAGE_INSET },
  serverPill: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: space[2],
    paddingHorizontal: space[3],
  },
  online: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  pressed: { opacity: opacity.pressed },
  content: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: PAGE_INSET,
    paddingBottom: 44,
  },
  title: { paddingBottom: 28 },
  fields: { gap: space[4], paddingBottom: 28 },
  actions: { gap: space[3] },
  eye: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
