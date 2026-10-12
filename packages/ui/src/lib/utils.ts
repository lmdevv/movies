import { createCn } from "cn/config";

/**
 * Join class names and resolve Tailwind conflicts (the last class wins), knowing the Paper theme
 * scale: without it, custom sizes such as `text-micro` read as colors and get dropped next to
 * `text-danger`.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: [
        "caption",
        "label",
        "body",
        "heading",
        "title",
        "display",
        "tab",
        "micro",
        "lead",
        "subtitle",
        "large-title",
        "hero-card",
        "hero",
      ],
      leading: ["caption", "label", "body", "heading", "title", "display"],
      "font-weight": ["regular", "heavy"],
      tracking: ["display", "caps", "snug", "hero", "spread"],
      radius: ["poster", "control", "card", "pill", "thumb"],
      shadow: ["overlay", "glass"],
      container: ["dialog", "content"],
    },
  },
});
