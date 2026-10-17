/**
 * Opens `movies://invite?server=…&code=…` links: connects to the invite's server when the app is
 * not connected yet, then shows Join Household. An invite for another server than the connected
 * one asks to change server first, so a link never signs anyone out by itself.
 */
import * as Linking from "expo-linking";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";

import { describeConnectFailure, discoverServer } from "@/lib/discovery";
import { parseInviteLink, sameServer } from "@/lib/invite-link";
import { displayHost } from "@/lib/local-network";

import { useConnection } from "./connection";
import { usePendingInvite } from "./pending-invite";

/** Handles invite links opened while the app runs or that launched it. Renders nothing. */
export function InviteLinks() {
  const url = Linking.useLinkingURL();
  const { connection, connect } = useConnection();
  const { setCode } = usePendingInvite();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const link = url === null ? null : parseInviteLink(url);

    if (link === null || handled.current === url) return;
    handled.current = url;

    if (connection !== null) {
      if (sameServer(connection.mediaUrl, link.mediaUrl)) setCode(link.code);
      else {
        Alert.alert(
          "Invite for Another Server",
          `This invite is for ${displayHost(link.mediaUrl)}. Change Server, then open it again.`,
        );
      }

      return;
    }

    void (async () => {
      const result = await discoverServer(link.mediaUrl);

      if (!result.ok) {
        Alert.alert("Can’t Open Invite", describeConnectFailure(result.failure));

        return;
      }

      setCode(link.code);
      connect(result.connection);
    })();
  }, [url, connection, connect, setCode]);

  return null;
}
