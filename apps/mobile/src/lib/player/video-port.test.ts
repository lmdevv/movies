import type { PlayerEvent } from "@movies/sdk/effect";
import { describe, expect, it } from "vitest";

import { NATIVE_SEEKER, VideoPort, withinBuffer } from "./video-port";
import type { NativeStatus, NativeVideo, NativeVideoEvents } from "./video-port";

/** Each native event's listeners. */
type Listeners = { [Name in keyof NativeVideoEvents]: Set<NativeVideoEvents[Name]> };

/**
 * An in-memory AVPlayer: it plays, pauses, and seeks at once, and the test drives what the native
 * side reports (status, the end, time updates).
 */
class TestVideo implements NativeVideo {
  currentTime = 0;
  playbackRate = 1;
  playing = false;
  status: NativeStatus = "idle";
  bufferedPosition = 0;
  released = false;
  readonly #listeners: Listeners = {
    playingChange: new Set(),
    statusChange: new Set(),
    playToEnd: new Set(),
    timeUpdate: new Set(),
  };

  play(): void {
    this.#use();
    this.playing = true;
    this.firePlaying(true);
  }

  pause(): void {
    this.#use();
    this.playing = false;
    this.firePlaying(false);
  }

  addListener<Name extends keyof NativeVideoEvents>(
    event: Name,
    listener: NativeVideoEvents[Name],
  ) {
    const set: Set<NativeVideoEvents[Name]> = this.#listeners[event];

    set.add(listener);

    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  /** Reports that AVPlayer started or stopped playing. */
  firePlaying(isPlaying: boolean): void {
    for (const listener of this.#listeners.playingChange) listener({ isPlaying });
  }

  /** Reports AVPlayer's loading state. */
  fireStatus(status: NativeStatus): void {
    for (const listener of this.#listeners.statusChange) listener({ status });
  }

  /** Reports the end of the media. */
  fireEnd(): void {
    for (const listener of this.#listeners.playToEnd) listener();
  }

  listenerCount(): number {
    return Object.values(this.#listeners).reduce((total, set) => total + set.size, 0);
  }

  #use(): void {
    if (this.released) throw new Error("released");
  }
}

/** A port following `video` from its start. */
const portOn = (video: TestVideo, seeker = NATIVE_SEEKER): VideoPort => {
  const port = new VideoPort();

  port.attach(video, 0, seeker);

  return port;
};

const recorded = (port: VideoPort): Array<PlayerEvent> => {
  const events: Array<PlayerEvent> = [];

  port.subscribe((event) => events.push(event));

  return events;
};

describe("VideoPort", () => {
  it("reports AVPlayer's position, play, pause, and end", async () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    await port.play();
    video.currentTime = 12.5;
    expect(port.positionMs()).toBe(12_500);
    expect(port.isPaused()).toBe(false);
    port.pause();
    expect(port.isPaused()).toBe(true);
    video.fireEnd();
    expect(events).toStrictEqual(["playing", "paused", "ended"]);
  });

  it("follows pauses from outside the app's controls", () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    video.play();
    video.pause();
    expect(events).toStrictEqual(["playing", "paused"]);
    expect(port.getState().playing).toBe(false);
  });

  it("counts a stall while meant to play as buffering", async () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    await port.play();
    video.fireStatus("loading");
    expect(port.isBuffering()).toBe(true);
    expect(events).toContain("waiting");
    video.fireStatus("readyToPlay");
    expect(port.isBuffering()).toBe(false);
  });

  it("seeks directly where AVPlayer reaches", () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    port.seek(42_000);
    expect(video.currentTime).toBe(42);
    expect(events).toStrictEqual(["seeked"]);
  });

  it("holds a moved stream's target until the move lands", async () => {
    const video = new TestVideo();
    const landings: Array<() => void> = [];

    const port = portOn(video, {
      reaches: () => false,
      move: (positionMs) =>
        new Promise((resolve) => {
          landings.push(() => {
            video.currentTime = positionMs / 1000;
            resolve();
          });
        }),
    });

    const events = recorded(port);

    await port.play();
    port.seek(3_600_000);
    // Reloading the stream pauses AVPlayer; that is not the viewer's pause.
    video.pause();
    expect(port.positionMs()).toBe(3_600_000);
    expect(port.isBuffering()).toBe(true);
    expect(port.isPaused()).toBe(false);
    landings[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toStrictEqual(["playing", "waiting", "seeked"]);
    expect(port.positionMs()).toBe(3_600_000);
  });

  it("drops a move a newer seek replaced", async () => {
    const video = new TestVideo();
    const signals: Array<AbortSignal> = [];

    const port = portOn(video, {
      reaches: (positionMs) => positionMs < 10_000,
      move: (_positionMs, signal) => {
        signals.push(signal);

        return Promise.resolve();
      },
    });

    const events = recorded(port);

    port.seek(60_000);
    port.seek(5_000);
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
    expect(port.positionMs()).toBe(5_000);
    expect(events).toStrictEqual(["waiting", "seeked"]);
  });

  it("reports a loading stream's start, without its pauses", () => {
    const video = new TestVideo();
    const port = new VideoPort();
    const events = recorded(port);

    port.attach(video, 600_000, NATIVE_SEEKER);
    video.pause();
    expect(port.positionMs()).toBe(600_000);
    expect(events).toStrictEqual([]);
    video.currentTime = 600;
    video.play();
    expect(events).toStrictEqual(["playing"]);
  });

  it("moves to the next stream's player and plays it as the viewer wanted", async () => {
    const first = new TestVideo();
    const next = new TestVideo();
    const port = portOn(first);
    const events = recorded(port);

    await port.play();
    port.attach(next, 1_200_000, NATIVE_SEEKER);
    first.pause();
    expect(next.playing).toBe(true);
    expect(events).toStrictEqual(["playing", "playing"]);
    next.currentTime = 1201;
    expect(port.positionMs()).toBe(1_201_000);
  });

  it("keeps the last position after disposal without touching the released player", () => {
    const video = new TestVideo();
    const port = portOn(video);

    video.currentTime = 90;
    video.play();
    port.dispose();
    video.released = true;
    video.currentTime = 0;
    expect(port.positionMs()).toBe(90_000);
    expect(port.isPaused()).toBe(true);
    port.pause();
    port.seek(5);
    expect(video.listenerCount()).toBe(0);
  });
});

describe("withinBuffer", () => {
  it("reaches from a little behind the playhead to what is buffered", () => {
    expect(withinBuffer(100, 130, 0, 120)).toBe(true);
    expect(withinBuffer(100, 130, 0, 80)).toBe(true);
    expect(withinBuffer(100, 130, 0, 130.4)).toBe(true);
    expect(withinBuffer(100, 130, 0, 140)).toBe(false);
    expect(withinBuffer(100, 130, 0, 60)).toBe(false);
    expect(withinBuffer(100, 0, 0, 100)).toBe(false);
  });

  it("holds nothing before the generation playing began", () => {
    expect(withinBuffer(2400, 2430, 2400, 2390)).toBe(false);
    expect(withinBuffer(2420, 2450, 2400, 2405)).toBe(true);
  });
});
