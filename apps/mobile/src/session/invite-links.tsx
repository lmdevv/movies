/**
 * Opens `movies://invite?server=…&code=…` links: connects to the invite's server when the app is
 * not connected yet, then shows Join Household. An invite for another server than the connected
 * one asks to change server first, so a link never signs anyone out by itself.
 */
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent } from "react";
import { Alert } from "react-native";

import { describeConnectFailure, discoverServer } from "@/lib/discovery";
import { parseInviteLink, sameServer } from "@/lib/invite-link";
import { displayHost } from "@/lib/local-network";

import { useConnection } from "./connection";
import { usePendingInvite } from "./pending-invite";

/** Handles invite links that launch the app or arrive while it runs. Renders nothing. */
export function InviteLinks() {
  const { connection, connect } = useConnection();
  const { setCode } = usePendingInvite();

  const open = useEffectEvent(async (url: string | null) => {
    const link = url === null ? null : parseInviteLink(url);

    if (link === null) return;

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

    const result = await discoverServer(link.mediaUrl);

    if (!result.ok) {
      Alert.alert("Can’t Open Invite", describeConnectFailure(result.failure));

      return;
    }

    setCode(link.code);
    connect(result.connection);
  });

  // Every opening counts, even of the same link twice, so this listens rather than reading the
  // latest URL.
  useEffect(() => {
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", ({ url }) => void open(url));

    return () => subscription.remove();
  }, []);

  return null;
}
