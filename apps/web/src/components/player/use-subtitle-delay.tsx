/**
 * The player's subtitle delay: the control under the subtitle choices, the G and H keys, and the
 * notice a key press shows. The playback controller holds the delay and moves the cues; this
 * decides whether it can apply to what shows and turns presses into steps.
 */
import type { NegotiateResponse } from "@movies/contracts/media-playback";
import { SubtitleDelay } from "@movies/ui/components/subtitle-delay";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { playerKeymap } from "@/lib/keymap";
import type { PlaybackController } from "@/playback/playback-controller";
import {
  SUBTITLE_DELAY,
  formatSubtitleDelay,
  parseSubtitleDelay,
  subtitleTiming,
} from "@/playback/subtitle-timing";
import type { SubtitleTiming } from "@/playback/subtitle-timing";

const NO_KEYS: ReadonlyArray<string> = [];

/** How long the notice of a key press stays. */
const NOTICE_MS = 1_500;

/** The subtitle delay as the player screen uses it. */
export interface PlayerSubtitleDelay {
  /** Whether the delay applies to what shows now, or why not. */
  readonly timing: SubtitleTiming;
  readonly delayMs: number;
  /** The control under the subtitle choices. */
  readonly control: ReactElement;
  /**
   * A step from the keyboard or the command menu (`-1` earlier, `1` later, `0` back to none),
   * which shows the new delay, or why it cannot apply, in `notice`.
   */
  readonly stepWithNotice: (direction: -1 | 0 | 1) => void;
  /** For a moment after such a step: the delay, such as `+0.5 s`, or why there is none. */
  readonly notice: string | null;
}

/** What a step's notice says: the delay it set, or why it could not set one (`reason`). */
const noticeFor = (delayMs: number | null, reason: string | null): string | null =>
  delayMs === null ? reason : `${formatSubtitleDelay(delayMs)} s`;

/**
 * The subtitle delay of `controller`'s playback.
 *
 * @param casting - A Chromecast plays the session.
 * @param otherScreen - AirPlay or the Remote Playback API plays the element elsewhere.
 * @param keycaps - Draw the G and H keycaps on the buttons; not on touch layouts.
 */
export const useSubtitleDelay = ({
  controller,
  stream,
  subtitleId,
  delayMs,
  casting,
  otherScreen,
  keycaps,
}: {
  readonly controller: PlaybackController | null;
  readonly stream: NegotiateResponse | null;
  readonly subtitleId: string | null;
  readonly delayMs: number;
  readonly casting: boolean;
  readonly otherScreen: boolean;
  readonly keycaps: boolean;
}): PlayerSubtitleDelay => {
  // A track chosen before its stream's list arrived is a text track: picture tracks are chosen
  // from that list.
  const track =
    subtitleId === null
      ? null
      : (stream?.subtitles.find((candidate) => candidate.id === subtitleId) ?? { kind: "text" });

  const timing = subtitleTiming({ track, casting, otherScreen });
  const adjustable = timing.adjustable;
  const reason = timing.adjustable ? null : timing.reason;
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // From the controller's delay now rather than the last render's, so quick presses add up.
  const step = useCallback(
    (direction: -1 | 0 | 1): number | null => {
      if (controller === null || !adjustable) return null;

      const current = controller.getSnapshot().subtitleDelayMs;

      controller.setSubtitleDelay(
        direction === 0 ? 0 : current + direction * SUBTITLE_DELAY.stepMs,
      );

      return controller.getSnapshot().subtitleDelayMs;
    },
    [controller, adjustable],
  );

  const stepWithNotice = useCallback(
    (direction: -1 | 0 | 1) => {
      const delay = step(direction);
      const said = noticeFor(delay, reason);

      if (said === null) return;
      setNotice(said);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
    },
    [step, reason],
  );

  const enter = useCallback(
    (text: string) => {
      const delay = parseSubtitleDelay(text);

      if (delay !== undefined && adjustable) controller?.setSubtitleDelay(delay);
    },
    [controller, adjustable],
  );

  const control = (
    <SubtitleDelay
      value={formatSubtitleDelay(delayMs)}
      unavailable={reason ?? undefined}
      resettable={delayMs !== 0}
      earlierKeys={keycaps ? playerKeymap.keycaps("player.subtitles-earlier") : NO_KEYS}
      laterKeys={keycaps ? playerKeymap.keycaps("player.subtitles-later") : NO_KEYS}
      onEarlier={() => step(-1)}
      onLater={() => step(1)}
      onReset={() => step(0)}
      onEntry={enter}
    />
  );

  return { timing, delayMs, control, stepWithNotice, notice };
};
