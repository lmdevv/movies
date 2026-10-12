/**
 * What this browser reports about media, read once: the input `detectCapabilities` needs, and
 * whether the page may set the volume (iPhones keep it with the hardware buttons).
 */
import type { MediaSupport } from "./capabilities";

/** This browser's media checks. */
export const browserMediaSupport = (): MediaSupport => {
  const probe = document.createElement("video");

  const source =
    window.ManagedMediaSource ?? ("MediaSource" in window ? window.MediaSource : undefined);

  return {
    canPlayType: (type) => probe.canPlayType(type),
    isTypeSupported: source === undefined ? null : (type: string) => source.isTypeSupported(type),
    hdrDisplay: window.matchMedia("(dynamic-range: high)").matches,
  };
};

/** Whether setting `volume` on a media element takes effect; iPhones ignore it. */
export const volumeIsSettable = (): boolean => {
  const probe = document.createElement("video");

  probe.volume = 0.5;

  return probe.volume === 0.5;
};
