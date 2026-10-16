/**
 * What this phone remembers between launches, besides the session tokens the SDK keeps: the
 * server it connected to, its device ID, and the profile last chosen on it. Everything is read once
 * at launch and parsed, so a missing or unreadable entry means "none" rather than a malformed
 * value. Screens read it with `useDevice`; the profile choice itself lives in `ProfileChoice`.
 */
import { DeviceId, ProfileId } from "@movies/contracts/ids";
import type { ServerLookup } from "@movies/sdk/effect";
import { randomUUID } from "expo-crypto";
import { Option, Schema } from "effect";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { deviceStore } from "./key-value";

/** Where the SDK keeps the session's tokens. */
export const SESSION_KEY = "movies.session";

const SERVER_KEY = "movies.server";

const DEVICE_KEY = "movies.device";

const PROFILE_KEY = "movies.profile";

const StoredServer = Schema.fromJsonString(
  Schema.Struct({ mediaUrl: Schema.NonEmptyString, convexUrl: Schema.NonEmptyString }),
);

const decodeServer = Schema.decodeUnknownOption(StoredServer);

const encodeServer = Schema.encodeSync(StoredServer);

const decodeDeviceId = Schema.decodeUnknownOption(DeviceId);

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

/** A stored value, or null when the keychain has none or cannot be read. */
const read = async (key: string): Promise<string | null> => {
  try {
    return await deviceStore.getItem(key);
  } catch {
    return null;
  }
};

/** What the phone remembered at launch. */
interface Remembered {
  readonly server: ServerLookup.ServerConnection | null;
  readonly deviceId: DeviceId;
  readonly profileId: ProfileId | null;
}

const remember = async (): Promise<Remembered> => {
  const [server, device, profile] = await Promise.all([
    read(SERVER_KEY),
    read(DEVICE_KEY),
    read(PROFILE_KEY),
  ]);

  const deviceId = await Option.match(decodeDeviceId(device), {
    onSome: (id) => Promise.resolve(id),
    onNone: async () => {
      // One ID per install, such as `ios-6f1c…`: one playback session and one room seat each.
      const created = DeviceId.make(`${Platform.OS}-${randomUUID()}`);

      try {
        await deviceStore.setItem(DEVICE_KEY, created);
      } catch {
        // Without a keychain the ID lasts for this launch.
      }

      return created;
    },
  });

  return {
    server: Option.getOrNull(decodeServer(server)),
    deviceId,
    profileId: Option.getOrNull(decodeProfileId(profile)),
  };
};

/** This phone's remembered state and the ways to change it. */
export interface Device {
  /** The server this phone signs in to, or null before one is connected. */
  readonly server: ServerLookup.ServerConnection | null;
  /** This install's device ID, for playback sessions and rooms. */
  readonly deviceId: DeviceId;
  /** The profile chosen when the app launched; `ProfileChoice` tracks it from there. */
  readonly launchProfileId: ProfileId | null;
  /**
   * Remembers `server`. Moving to another Convex deployment forgets the session and the profile
   * choice, which belong to the old one.
   */
  readonly connect: (server: ServerLookup.ServerConnection) => Promise<void>;
  /** Remembers (or forgets, with null) the profile chosen on this phone. */
  readonly saveProfile: (profileId: ProfileId | null) => Promise<void>;
}

const DeviceContext = createContext<Device | null>(null);

/** Props for `DeviceProvider`. */
interface DeviceProviderProps {
  /** Drawn while the keychain is read, a fraction of a second at launch. */
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

/** Reads what the phone remembers, then provides it to `children`. */
export function DeviceProvider({ fallback, children }: DeviceProviderProps) {
  const [remembered, setRemembered] = useState<Remembered | null>(null);

  useEffect(() => {
    // Read once; a development double mount ignores the first read's answer.
    const mounted = { current: true };

    void (async () => {
      const value = await remember();

      if (mounted.current) setRemembered(value);
    })();

    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = useCallback(
    async (server: ServerLookup.ServerConnection) => {
      if (remembered !== null && remembered.server?.convexUrl !== server.convexUrl) {
        await Promise.all([
          deviceStore.removeItem(SESSION_KEY),
          deviceStore.removeItem(PROFILE_KEY),
        ]);
      }

      await deviceStore.setItem(SERVER_KEY, encodeServer(server));
      setRemembered((current) =>
        current === null
          ? current
          : {
              ...current,
              server,
              profileId: current.server?.convexUrl === server.convexUrl ? current.profileId : null,
            },
      );
    },
    [remembered],
  );

  const saveProfile = useCallback(async (profileId: ProfileId | null) => {
    await (profileId === null
      ? deviceStore.removeItem(PROFILE_KEY)
      : deviceStore.setItem(PROFILE_KEY, profileId));
  }, []);

  const value = useMemo(
    (): Device | null =>
      remembered === null
        ? null
        : {
            server: remembered.server,
            deviceId: remembered.deviceId,
            launchProfileId: remembered.profileId,
            connect,
            saveProfile,
          },
    [remembered, connect, saveProfile],
  );

  if (value === null) return fallback;

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

/**
 * This phone's remembered state.
 *
 * @throws When used outside `DeviceProvider`, a programming error.
 */
export const useDevice = (): Device => {
  const device = useContext(DeviceContext);

  if (device === null) throw new Error("useDevice must be used inside DeviceProvider");

  return device;
};
