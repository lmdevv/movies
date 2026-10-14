/**
 * React bindings for web playback: a `PlaybackController` per request and element, and the
 * element's own state (time, buffering, volume) for the controls.
 */
import { useMoviesRuntime } from "@movies/sdk/react";
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";

import { browserMediaSupport } from "./browser-support";
import { detectCapabilities } from "./capabilities";
import type { MediaElementPlayer } from "./media-element-player";
import { PlaybackController } from "./playback-controller";
import type { PlaybackRequest, PlaybackSnapshot } from "./playback-controller";
import { usesHlsJs } from "./stream-attachment";

/** A controller and its latest state. */
export interface PlaybackHandle {
  readonly controller: PlaybackController;
  readonly snapshot: PlaybackSnapshot;
}

const subscribeNothing = (): (() => void) => () => undefined;

/**
 * Plays `request` in `element` while both stay the same, disposing the controller (and ending the
 * session) on change or unmount. `key` names the request: a new key starts a new session.
 */
export const usePlayback = (
  element: HTMLVideoElement | null,
  request: PlaybackRequest | null,
  key: string,
): PlaybackHandle | null => {
  const runtime = useMoviesRuntime();
  const [controller, setController] = useState<PlaybackController | null>(null);
  // The request as of the render that changed `key`; later changes to it do not restart playback.
  const currentRequest = useEffectEvent(() => request);

  useEffect(() => {
    const started = currentRequest();

    if (element === null || started === null) return undefined;

    const capabilities = detectCapabilities(browserMediaSupport());

    const created = new PlaybackController(
      runtime,
      element,
      capabilities,
      usesHlsJs(capabilities.mse),
      started,
    );

    setController(created);
    void created.start();

    return () => {
      created.dispose();
      setController(null);
    };
  }, [runtime, element, key]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    () => controller?.getSnapshot() ?? null,
  );

  return useMemo(
    () => (controller === null || snapshot === null ? null : { controller, snapshot }),
    [controller, snapshot],
  );
};

/** The element's state as the controls draw it. */
export interface MediaState {
  /** Where playback is, holding a seek's target until it lands. */
  readonly positionSeconds: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly buffering: boolean;
  /** Seconds buffered ahead of the position. */
  readonly bufferedAheadSeconds: number;
  readonly volume: number;
  readonly muted: boolean;
}

const MEDIA_EVENTS = [
  "timeupdate",
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "progress",
  "volumechange",
  "ended",
  "loadeddata",
  "emptied",
] as const;

const IDLE: MediaState = {
  positionSeconds: 0,
  paused: true,
  ended: false,
  buffering: false,
  bufferedAheadSeconds: 0,
  volume: 1,
  muted: false,
};

const bufferedAhead = (element: HTMLVideoElement): number => {
  const now = element.currentTime;
  const { buffered } = element;

  const range = Array.from({ length: buffered.length }, (_, index) => index).find(
    (index) => buffered.start(index) - 0.5 <= now && now <= buffered.end(index),
  );

  return range === undefined ? 0 : Math.max(0, buffered.end(range) - now);
};

const sameState = (left: MediaState, right: MediaState): boolean =>
  Math.abs(left.positionSeconds - right.positionSeconds) < 0.05 &&
  left.paused === right.paused &&
  left.ended === right.ended &&
  left.buffering === right.buffering &&
  Math.abs(left.bufferedAheadSeconds - right.bufferedAheadSeconds) < 0.5 &&
  left.volume === right.volume &&
  left.muted === right.muted;

/** Follows `element` through `player`, re-rendering on its media events. */
export const useMediaState = (
  element: HTMLVideoElement | null,
  player: MediaElementPlayer | null,
): MediaState => {
  const store = useMemo(() => {
    let current = IDLE;

    const read = (): MediaState => {
      if (element === null || player === null) return IDLE;

      const next: MediaState = {
        positionSeconds: player.positionMs() / 1000,
        paused: element.paused,
        ended: element.ended,
        buffering: player.isBuffering(),
        bufferedAheadSeconds: bufferedAhead(element),
        volume: element.volume,
        muted: element.muted,
      };

      if (!sameState(current, next)) current = next;

      return current;
    };

    const subscribe = (onChange: () => void): (() => void) => {
      if (element === null || player === null) return () => undefined;

      for (const type of MEDIA_EVENTS) element.addEventListener(type, onChange);

      const unsubscribe = player.subscribe(onChange);

      return () => {
        for (const type of MEDIA_EVENTS) element.removeEventListener(type, onChange);
        unsubscribe();
      };
    };

    return { read, subscribe };
  }, [element, player]);

  return useSyncExternalStore(store.subscribe, store.read, store.read);
};
