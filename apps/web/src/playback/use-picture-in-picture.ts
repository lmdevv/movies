/**
 * Picture in picture for the player's `<video>`: the standard API where the browser has it, and
 * Safari's presentation modes otherwise.
 */
import { useCallback, useEffect, useState } from "react";

/** Picture in picture as the player uses it. */
export interface PictureInPicture {
  readonly active: boolean;
  readonly toggle: () => void;
}

const PIP = "picture-in-picture";

const standard = (video: HTMLVideoElement): boolean =>
  document.pictureInPictureEnabled && !video.disablePictureInPicture;

const webkit = (video: HTMLVideoElement): boolean =>
  video.webkitSupportsPresentationMode?.(PIP) === true &&
  video.webkitSetPresentationMode !== undefined;

/** Picture in picture for `video`, or null where the browser offers none. */
export const usePictureInPicture = (video: HTMLVideoElement | null): PictureInPicture | null => {
  const [active, setActive] = useState(false);
  const supported = video !== null && (standard(video) || webkit(video));

  useEffect(() => {
    if (video === null || !supported) return undefined;

    const onChange = (): void =>
      setActive(document.pictureInPictureElement === video || video.webkitPresentationMode === PIP);

    const types = [
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ];

    for (const type of types) video.addEventListener(type, onChange);

    return () => {
      for (const type of types) video.removeEventListener(type, onChange);
    };
  }, [video, supported]);

  const toggle = useCallback(() => {
    if (video === null) return;

    if (standard(video)) {
      void (
        document.pictureInPictureElement === video
          ? document.exitPictureInPicture()
          : video.requestPictureInPicture()
      ).catch(() => undefined);

      return;
    }

    video.webkitSetPresentationMode?.(video.webkitPresentationMode === PIP ? "inline" : PIP);
  }, [video]);

  return supported ? { active, toggle } : null;
};
