import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CastFramework,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";
import { CastPlayer } from "./cast-player";

const ANY_CHANGE = "anyChanged";

/**
 * A receiver whose mirror lags its commands, as a real one does over the network: `playOrPause`
 * reaches it at once, but the mirror only reports the new state on `deliver`.
 */
const laggingReceiver = () => {
  const handlers = new Set<(event: RemotePlayerChange) => void>();
  let receiverPaused = false;
  let mirrorPaused = false;
  // The receiver's state after each command, in order, until the mirror reports it.
  const unreported: Array<boolean> = [];
  let toggles = 0;

  /** The Cast SDK's mirror of the receiver's player. */
  class FakeRemotePlayer implements RemotePlayer {
    readonly isConnected = true;
    readonly isMediaLoaded = true;
    get isPaused(): boolean {
      return mirrorPaused;
    }

    readonly isMuted = false;
    readonly duration = 600;
    readonly playerState = "PLAYING";
    currentTime = 30;
    volumeLevel = 1;
  }

  /** Commands reach the receiver at once; the mirror hears about them later. */
  class FakeController implements RemotePlayerController {
    playOrPause(): void {
      toggles += 1;
      receiverPaused = !receiverPaused;
      unreported.push(receiverPaused);
    }

    seek(): void {}

    stop(): void {}

    muteOrUnmute(): void {}

    setVolumeLevel(): void {}

    addEventListener(_type: string, handler: (event: RemotePlayerChange) => void): void {
      handlers.add(handler);
    }

    removeEventListener(_type: string, handler: (event: RemotePlayerChange) => void): void {
      handlers.delete(handler);
    }
  }

  const framework: CastFramework = {
    CastContext: {
      getInstance: () => {
        throw new Error("The cast player never reads the context");
      },
    },
    CastContextEventType: { CAST_STATE_CHANGED: "cast", SESSION_STATE_CHANGED: "session" },
    RemotePlayer: FakeRemotePlayer,
    RemotePlayerController: FakeController,
    RemotePlayerEventType: { ANY_CHANGE },
  };

  return {
    framework,
    /** The mirror reports the receiver's next state, if one is on its way. */
    deliverOne: () => {
      const next = unreported.shift();

      if (next === undefined || next === mirrorPaused) return;
      mirrorPaused = next;

      for (const handler of handlers) handler({ field: "isPaused", value: next });
    },
    /** The mirror reports every state on its way. */
    deliver: () => {
      for (const next of unreported.splice(0)) {
        if (next === mirrorPaused) continue;
        mirrorPaused = next;

        for (const handler of handlers) handler({ field: "isPaused", value: next });
      }
    },
    /** The last command never reached the receiver. */
    loseLast: () => {
      unreported.pop();
      receiverPaused = !receiverPaused;
    },
    receiverPaused: () => receiverPaused,
    toggles: () => toggles,
  };
};

const castPlayer = (framework: CastFramework): CastPlayer =>
  new CastPlayer(
    framework,
    () => Promise.resolve(),
    () => null,
    () => undefined,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("CastPlayer", () => {
  it("sends one toggle at a time, and the next once the mirror shows the first", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    player.pause();
    await player.play();
    expect(receiver.toggles()).toBe(1);

    // The pause shows; the player is asked to play, so it toggles back, once.
    receiver.deliverOne();
    expect(receiver.toggles()).toBe(2);
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("trusts the mirror again when a toggle never shows", async () => {
    vi.useFakeTimers();

    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.loseLast();
    expect(player.isPaused()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(player.isPaused()).toBe(false);

    player.pause();
    receiver.deliver();
    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("plays again when asked before the receiver has reported an earlier pause", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("pauses again when asked before the receiver has reported an earlier play", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.deliver();
    await player.play();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("keeps a play asked after a pause while the pause's report arrives", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    // The pause's report arrives; the play's is still on its way.
    receiver.deliverOne();
    await player.play();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("follows the mirror again once it has reported every command", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.deliver();
    await player.play();
    receiver.deliver();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("reports what was asked as soon as it is asked", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    expect(player.isPaused()).toBe(true);
    expect(player.getState().paused).toBe(true);
    await player.play();
    expect(player.isPaused()).toBe(false);
    receiver.deliverOne();
    expect(player.isPaused()).toBe(false);
  });

  it("sends nothing when asked for the state the receiver is already in", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    await player.play();
    player.pause();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
  });
});
