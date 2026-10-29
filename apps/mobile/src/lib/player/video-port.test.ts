import type { PlayerEvent } from "@movies/sdk/effect";
import { describe, expect, it } from "vitest";

import { NATIVE_SEEKER, VideoPort, withinBuffer } from "./video-port";
import type { NativeStatus, NativeVideo, NativeVideoEvents } from "./video-port";

type Listeners = { [Name in keyof NativeVideoEvents]: Set<NativeVideoEvents[Name]> };

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

  firePlaying(isPlaying: boolean): void {
    for (const listener of this.#listeners.playingChange) listener({ isPlaying });
  }

  fireStatus(status: NativeStatus): void {
    for (const listener of this.#listeners.statusChange) listener({ status });
  }

  fireEnd(): void {
    for (const listener of this.#listeners.playToEnd) listener();
  }

  /** AVPlayer's periodic time report, at `seconds`. */
  fireTime(seconds: number): void {
    this.currentTime = seconds;

    for (const listener of this.#listeners.timeUpdate) {
      listener({
        currentTime: seconds,
        currentLiveTimestamp: null,
        currentOffsetFromLive: null,
        bufferedPosition: this.bufferedPosition,
      });
    }
  }

  /** AVPlayer stalls for data: `waitingToPlay` makes expo-video report loading, then not playing. */
  stall(): void {
    this.status = "loading";
    this.fireStatus("loading");
    this.playing = false;
    this.firePlaying(false);
  }

  listenerCount(): number {
    return Object.values(this.#listeners).reduce((total, set) => total + set.size, 0);
  }

  #use(): void {
    if (this.released) throw new Error("released");
  }
}

/** A monotonic clock the test moves by hand. */
class TestClock {
  ms = 0;
  readonly now = (): number => this.ms;
}

/** Plays `video` along for `seconds` of wall time, reporting every quarter second as AVPlayer does. */
const playFor = (video: TestVideo, clock: TestClock, seconds: number): void => {
  for (let step = 0; step < seconds * 4; step += 1) {
    clock.ms += 250;
    video.fireTime(video.currentTime + 0.25);
  }
};

const portOn = (video: TestVideo, seeker = NATIVE_SEEKER): VideoPort => {
  const port = new VideoPort();

  port.attach(video, { positionMs: 0, durationMs: null, seeker });

  return port;
};

const recorded = (port: VideoPort): Array<PlayerEvent> => {
  const events: Array<PlayerEvent> = [];

  port.subscribe((event) => events.push(event));

  return events;
};

describe("VideoPort", () => {
  it("reports AVPlayer's position, play, pause, and end", async () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    port.attach(video, { positionMs: 0, durationMs: null, seeker: NATIVE_SEEKER });

    const events = recorded(port);

    await port.play();
    clock.ms += 12_500;
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
    // A seek the media service must transcode toward may take as long as a new stream.
    expect(port.settling()).toBe(true);
    landings[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toStrictEqual(["playing", "waiting", "seeked"]);
    expect(port.positionMs()).toBe(3_600_000);
    expect(port.settling()).toBe(false);
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

    port.attach(video, { positionMs: 600_000, durationMs: null, seeker: NATIVE_SEEKER });
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
    port.attach(next, { positionMs: 1_200_000, durationMs: null, seeker: NATIVE_SEEKER });
    first.pause();
    expect(next.playing).toBe(true);
    expect(events).toStrictEqual(["playing", "playing"]);
    next.currentTime = 1201;
    expect(port.positionMs()).toBe(1_201_000);
  });

  it("keeps the last position after disposal without touching the released player", () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    port.attach(video, { positionMs: 0, durationMs: null, seeker: NATIVE_SEEKER });
    video.play();
    playFor(video, clock, 90);
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

const MINUTES_36 = 36 * 60;

const EPISODE_MS = 47 * 60 * 1000;

/** A port playing a 47-minute episode, ten seconds after it started playing at `seconds`. */
const playingAt = (seconds: number) => {
  const clock = new TestClock();
  const video = new TestVideo();
  const port = new VideoPort(clock.now);
  const events = recorded(port);

  port.attach(video, {
    positionMs: seconds * 1000,
    durationMs: EPISODE_MS,
    seeker: NATIVE_SEEKER,
  });
  video.currentTime = seconds;
  void port.play();
  playFor(video, clock, 10);

  return { clock, video, port, events };
};

describe("VideoPort when the stream vanishes", () => {
  it("keeps the position it played to when AVPlayer skips the missing segments to the end", async () => {
    const { clock, video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    // Every segment answers 404: AVPlayer races to the end of the playlist and calls it the end.
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000);
    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();

    expect(reached).toBeCloseTo((MINUTES_36 + 10) * 1000, -2);
    expect(port.positionMs()).toBe(reached);
    expect(port.getState().positionSeconds * 1000).toBe(reached);
    expect(events).not.toContain("ended");
    // AVPlayer's stop before its end looks like any pause, until the end shows it was not one.
    expect(events.at(-1)).toBe("waiting");
    expect(port.wantsToPlay()).toBe(true);
    expect(port.isBuffering()).toBe(true);

    // Pressing play now must not start the episode over.
    await port.play();
    expect(port.positionMs()).toBe(reached);
    expect(video.currentTime).not.toBe(0);
  });

  it("treats an end AVPlayer reports far from the media's end as a lost stream", () => {
    const { video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    // AVPlayer gives up on the playlist without moving its clock.
    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();

    expect(events).not.toContain("ended");
    expect(port.positionMs()).toBe(reached);
    expect(port.isBuffering()).toBe(true);
  });

  it("keeps the position it played to when the native player resets to zero", () => {
    const { clock, video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    video.stall();
    clock.ms += 250;
    video.fireTime(0);
    video.currentTime = 0.126;

    expect(port.positionMs()).toBe(reached);
    expect(port.getState().positionSeconds * 1000).toBe(reached);
    expect(events).not.toContain("paused");
    expect(port.isPaused()).toBe(false);
    expect(port.isBuffering()).toBe(true);
  });

  it("counts a stall as buffering, not as the viewer pausing", () => {
    const { port, video, events } = playingAt(600);

    video.stall();

    expect(events).toContain("waiting");
    expect(events).not.toContain("paused");
    expect(port.wantsToPlay()).toBe(true);
    expect(port.isPaused()).toBe(false);
  });

  it("still ends at the real end, and plays from the start after it", async () => {
    const { clock, video, port, events } = playingAt(EPISODE_MS / 1000 - 10);

    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();
    expect(events.at(-1)).toBe("ended");
    expect(port.getState().ended).toBe(true);

    clock.ms += 1_000;
    await port.play();
    expect(video.currentTime).toBe(0);
  });

  it("follows a jump AVPlayer makes on its own once it plays on from there", () => {
    const { clock, video, port } = playingAt(600);

    // A seek from the lock screen moves AVPlayer without the app.
    clock.ms += 250;
    video.fireTime(1_500);
    expect(port.positionMs()).toBeCloseTo(610_000, -3);

    playFor(video, clock, 4);
    expect(port.positionMs()).toBeCloseTo(1_504_000, -3);
  });

  it("counts no loading time as played", () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    port.attach(video, { positionMs: 600_000, durationMs: EPISODE_MS, seeker: NATIVE_SEEKER });
    void port.play();
    video.currentTime = 600;
    clock.ms += 30_000;
    video.firePlaying(true);
    clock.ms += 250;
    video.fireTime(630);

    expect(port.positionMs()).toBe(600_000);
  });

  it("takes a pause right after a jump from the lock screen as the viewer's", () => {
    const { clock, video, port, events } = playingAt(600);

    clock.ms += 250;
    video.fireTime(615);
    clock.ms += 500;
    video.pause();

    expect(events.at(-1)).toBe("paused");
    expect(port.wantsToPlay()).toBe(false);
    expect(port.isBuffering()).toBe(false);

    clock.ms += 60_000;
    video.play();
    playFor(video, clock, 3);
    expect(port.positionMs()).toBeCloseTo(618_000, -3);
  });

  it("never follows a reset player that sits at zero", () => {
    const { clock, video, port } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    video.stall();

    for (let tick = 0; tick < 120; tick += 1) {
      clock.ms += 250;
      video.fireTime(0);
    }

    expect(port.positionMs()).toBe(reached);
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
