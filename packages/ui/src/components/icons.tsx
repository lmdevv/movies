import type { ComponentProps } from "react";

type GlyphProps = Omit<ComponentProps<"svg">, "children">;

/** Filled play triangle, as on Play buttons and the transport. */
export function PlayGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M7 4v16l13-8z" />
    </svg>
  );
}

/** Filled pause bars for the transport. */
export function PauseGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
    </svg>
  );
}

/** Filled skip-to-next glyph for the next episode button. */
export function SkipNextGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M5 4v16l11-8zM18 4h2v16h-2z" />
    </svg>
  );
}
