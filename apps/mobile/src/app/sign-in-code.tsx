/**
 * A05 · Sign In with a Code: shows a code to approve from a signed-in device and signs in once
 * someone does. A10 · Code Expired shows when the code runs out or is denied.
 */
import { useAuth } from "@movies/sdk/react";
import { Predicate } from "effect";
import { Lock } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Share, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { codeGroups, expiresInLine, spokenCode } from "@/lib/device-code";
import { describeFailure } from "@/lib/failure";

/** How the approving person sees this device. */
const CLIENT_NAME = "[movies] for iPhone";

type Attempt =
  | { readonly kind: "starting" }
  | {
      readonly kind: "waiting";
      readonly userCode: string;
      readonly verificationUrl: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

/** The current time, refreshed every second while `active`. */
const useSecondClock = (active: boolean): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [active]);

  return now;
};

/** Starts a device sign-in for each `round` and follows it until it signs in or ends. */
const useDeviceLogin = (round: number): Attempt => {
  const { startDeviceLogin } = useAuth();
  const [attempt, setAttempt] = useState<Attempt>({ kind: "starting" });

  useEffect(() => {
    const run = { current: true };

    setAttempt({ kind: "starting" });

    void (async () => {
      try {
        const login = await startDeviceLogin(CLIENT_NAME);

        if (!run.current) return;
        setAttempt({
          kind: "waiting",
          userCode: login.userCode,
          verificationUrl: login.verificationUrl,
          expiresAt: login.expiresAt,
        });
        // Signing in changes the session phase, which leaves this screen.
        await login.complete();
      } catch (cause) {
        if (!run.current) return;
        setAttempt(
          Predicate.isTagged(cause, "DeviceLoginRefused")
            ? { kind: "expired" }
            : { kind: "failed", message: describeFailure(cause) },
        );
      }
    })();

    return () => {
      run.current = false;
    };
  }, [round, startDeviceLogin]);

  return attempt;
};

function CodeBoxes({ userCode }: { readonly userCode: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`Code ${spokenCode(userCode)}`}
      className="flex-row justify-center gap-3"
    >
      {codeGroups(userCode).map((group, groupIndex) => (
        <View key={groupIndex} className="flex-row gap-1.5">
          {group.map((character, index) => (
            <View
              key={index}
              className="h-16 w-9 items-center justify-center rounded-control bg-surface"
            >
              <Text variant="title" maxFontSizeMultiplier={1}>
                {character}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export default function SignInWithCode() {
  const [round, setRound] = useState(0);
  const attempt = useDeviceLogin(round);
  const now = useSecondClock(attempt.kind === "waiting");
  const again = () => setRound((current) => current + 1);

  if (attempt.kind === "expired" || attempt.kind === "failed") {
    return (
      <Screen header={<NavHeader />}>
        <CalmState
          icon={Lock}
          title={attempt.kind === "expired" ? "Code expired" : "Can’t get a code"}
          description={
            attempt.kind === "expired" ? "Request a new code to sign in." : attempt.message
          }
          actions={<Button label="Get a New Code" onPress={again} />}
        />
      </Screen>
    );
  }

  return (
    <Screen header={<NavHeader title="Sign In with a Code" />}>
      <View className="gap-4 px-5 py-4">
        <View className="h-12" />
        <Text variant="subheading">Enter this code on a signed-in device.</Text>
        <View className="h-4" />
        {attempt.kind === "waiting" ? (
          <>
            <CodeBoxes userCode={attempt.userCode} />
            <Text variant="secondary" tone="muted">
              {expiresInLine(attempt.expiresAt, now)}
            </Text>
            <ListRow
              icon={Lock}
              title="Waiting for Approval"
              subtitle={attempt.verificationUrl.replace(/^https?:\/\//u, "")}
              onPress={() => void Share.share({ url: attempt.verificationUrl })}
            />
          </>
        ) : null}
      </View>
    </Screen>
  );
}
