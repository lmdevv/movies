/**
 * A08 · Server Unavailable: the server did not answer, whether typed on Connect to Server or
 * remembered from before. Try Again asks again; Change Server goes back to choosing one.
 */
import { Wifi } from "lucide-react-native";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";

/** Props for `ServerUnavailable`. */
export interface ServerUnavailableProps {
  /** The line under the heading, such as `cinema.home is unavailable.` */
  readonly description: string;
  readonly onRetry?: (() => void) | undefined;
  readonly retrying?: boolean;
  readonly onChangeServer: () => void;
  /** Shows the back button, for the pushed screen after Connect to Server. */
  readonly onBack?: () => void;
  /** Another way out under Change Server, such as Sign Out. */
  readonly extra?: ReactNode;
}

/** Can't reach your server. */
export function ServerUnavailable({
  description,
  onRetry,
  retrying = false,
  onChangeServer,
  onBack,
  extra,
}: ServerUnavailableProps) {
  return (
    <Screen header={onBack === undefined ? undefined : <NavHeader onBack={onBack} />}>
      <CalmState
        icon={Wifi}
        title="Can’t reach your server"
        description={description}
        actions={
          <>
            {onRetry === undefined ? null : (
              <Button label="Try Again" busy={retrying} onPress={onRetry} />
            )}
            <Button label="Change Server" variant="secondary" onPress={onChangeServer} />
            {extra}
          </>
        }
      />
    </Screen>
  );
}
