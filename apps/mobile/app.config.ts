/**
 * The iPhone app's Expo configuration. Plain-HTTP servers on a LAN or tailnet are the common case
 * for a self-hosted install, and their host names are whatever people chose, so App Transport
 * Security allows arbitrary loads: per-domain exceptions cannot name them, and
 * `NSAllowsLocalNetworking` covers neither `movies.home.lan` nor `nas.tailnet.ts.net`. The app is
 * portrait; every orientation stays declared so the player can rotate, and the root layout locks
 * portrait at launch.
 */
import type { ExpoConfig } from "expo/config";

import manifest from "./package.json";

const config: ExpoConfig = {
  name: "[movies]",
  slug: "movies",
  scheme: "movies",
  version: manifest.version,
  orientation: "default",
  userInterfaceStyle: "dark",
  backgroundColor: "#000000",
  platforms: ["ios", "web"],
  ios: {
    // A placeholder until the App Store identifier is registered.
    bundleIdentifier: "dev.movies.app",
    supportsTablet: false,
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription: "[movies] connects to your server on this network.",
    },
  },
  web: { output: "single", bundler: "metro" },
  plugins: ["expo-router"],
  // Builds run in Expo Go for now; there are no over-the-air updates to configure.
  updates: { enabled: false },
  experiments: { typedRoutes: true },
};

export default config;
