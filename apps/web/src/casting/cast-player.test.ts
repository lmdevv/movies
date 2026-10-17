import { describe, expect, it } from "vitest";

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
      receiverPaused = !receiverPaused;
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
    /** The mirror catches up with the receiver, reporting a change if there is one. */
    deliver: () => {
      if (mirrorPaused === receiverPaused) return;
      mirrorPaused = receiverPaused;

      for (const handler of handlers) handler({ field: "isPaused", value: receiverPaused });
    },
    receiverPaused: () => receiverPaused,
  };
};

const castPlayer = (framework: CastFramework): CastPlayer =>
  new CastPlayer(
    framework,
    () => Promise.resolve(),
    () => null,
    () => undefined,
  );

describe("CastPlayer", () => {
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
