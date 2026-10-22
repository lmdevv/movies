import { useEffect, useEffectEvent } from "react";

import { chordFromEvent, stepKeymap } from "./keymap";
import type { KeySequence, Keymap, Platform } from "./keymap";

const SEQUENCE_TIMEOUT_MS = 1000;

/** The keyboard family of this browser, for resolving `mod` and drawing keycaps. */
export function detectPlatform(): Platform {
  return /mac|iphone|ipad|ipod/iu.test(navigator.userAgent) ? "mac" : "other";
}

/**
 * Whether a key event comes from a place where people type text, so plain keys must not fire. A
 * slider's range input takes no text: its own keys (arrows, Home, End, Page Up and Down) are its,
 * and the rest stay shortcuts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target instanceof HTMLInputElement && target.type === "range") return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Run registry shortcuts from window key presses, including two-key sequences such as `g h`.
 *
 * Plain keys are ignored while a text field has focus unless the entry sets `whileTyping`. Events
 * that something else already handled (`defaultPrevented`) are ignored. A matched shortcut prevents
 * the browser default.
 *
 * @param handlers - What each shortcut does; ids without a handler are ignored.
 * @param enabled - Pass `false` to pause every shortcut, for example while a modal owns the keys.
 */
export function useKeymap<Id extends string>(
  keymap: Keymap<Id>,
  handlers: Partial<Record<Id, (event: KeyboardEvent) => void>>,
  enabled = true,
): void {
  const handlerFor = useEffectEvent((id: Id) => handlers[id]);

  useEffect(() => {
    if (!enabled) return undefined;

    let prefix: KeySequence = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const live = new Set(
      keymap.entries.filter((entry) => entry.whileTyping === true).map((entry) => entry.id),
    );

    const typingBindings = keymap.bindings.filter((binding) => live.has(binding.id));

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;

      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;

      const typing = isTypingTarget(event.target);

      const step = typing
        ? stepKeymap(typingBindings, [], chordFromEvent(event))
        : stepKeymap(keymap.bindings, prefix, chordFromEvent(event));

      clearTimeout(timer);
      prefix = [];

      if (step.kind === "pending") {
        prefix = step.prefix;
        timer = setTimeout(() => {
          prefix = [];
        }, SEQUENCE_TIMEOUT_MS);

        return;
      }

      if (step.kind !== "matched") return;

      const handler = handlerFor(step.id);

      if (handler === undefined) return;

      event.preventDefault();
      handler(event);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [keymap, enabled]);
}
