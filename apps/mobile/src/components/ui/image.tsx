/** Expo Image with `className` support: cached, decoded off the main thread, with fade-ins. */
import { Image as ExpoImage } from "expo-image";
import { withUniwind } from "uniwind";

export const Image = withUniwind(ExpoImage);
