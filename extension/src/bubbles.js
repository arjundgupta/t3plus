import { LOOK, setLook } from "./composer.js";

// Chat bubbles: your messages in a color of your own (Settings → t3+, or the open
// profile's). T3 paints a user message's bubble with --message-surface (class
// bg-message); t3+ paints only the user rows' bubbles, and their text in white or
// near-black, whichever reads better on the color. Nothing else in T3 changes.
// The colors go on the bubbles themselves (composer.js setLook): on <html>, a switch
// between profiles with different bubbles restyled the whole page.

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LIGHT_INK = "#ffffff";
const DARK_INK = "#111113";

/** WCAG relative luminance of a "#rrggbb". */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The text color for a bubble of `hex`: white where it reads at 3:1 or better (blue,
 * red, purple, pink: the usual white-on-color bubble), else near-black (yellow, green,
 * teal, orange, pale colors). Not WCAG 2's 4.5:1: that gives those mid-tone bubbles dark
 * text, which reads worse on them (APCA on #3b82f6: white Lc 69, near-black Lc 40).
 */
export function bubbleInk(hex) {
  return 1.05 / (luminance(hex) + 0.05) >= 3 ? LIGHT_INK : DARK_INK;
}

/**
 * Colors the user messages' bubbles `hex` ("#rrggbb"), or gives them back to T3 (null).
 * `own`: the color set in Settings (null for T3's), which a profile's "Default" swatch shows.
 */
export function applyBubble(doc, hex, own = null) {
  const color = typeof hex === "string" && HEX_COLOR.test(hex) ? hex.toLowerCase() : null;
  setLook(doc, LOOK.bubble, { "--t3plus-bubble": color, "--t3plus-bubble-ink": color && bubbleInk(color) });
  setLook(doc, LOOK.editor, { "--t3plus-bubble-own": typeof own === "string" && HEX_COLOR.test(own) ? own.toLowerCase() : null });
  doc.documentElement.toggleAttribute("data-t3plus-bubble", color !== null);
}

/** t3+ stopped: T3's bubbles again. */
export function clearBubble(doc) {
  applyBubble(doc, null, null);
}
