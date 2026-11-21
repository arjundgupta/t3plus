import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBubble, bubbleInk, clearBubble } from "../src/bubbles.js";
import { LOOK, lookValue } from "../src/composer.js";
import { createDom } from "./helpers.js";

// Chat bubbles in a profile's color (bubbles.js): their text ink, and where the colors live.

test("chat bubbles: white or near-black text, whichever reads; colored only while one is set", () => {
  assert.equal(bubbleInk("#3b82f6"), "#ffffff", "blue: white text");
  assert.equal(bubbleInk("#1e1e1e"), "#ffffff");
  assert.equal(bubbleInk("#22c55e"), "#111113", "green: dark text");
  assert.equal(bubbleInk("#eab308"), "#111113", "yellow: dark text");
  assert.equal(bubbleInk("#ffffff"), "#111113");
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  const root = doc.documentElement;
  // On the bubbles themselves (on <html>, a switch between two profiles' bubbles restyled the whole page).
  const bubble = (name) => lookValue(doc, LOOK.bubble, name);
  applyBubble(doc, "#3B82F6", "#22c55e");
  assert.equal(root.hasAttribute("data-t3plus-bubble"), true);
  assert.equal(bubble("--t3plus-bubble"), "#3b82f6");
  assert.equal(bubble("--t3plus-bubble-ink"), "#ffffff");
  assert.equal(lookValue(doc, LOOK.editor, "--t3plus-bubble-own"), "#22c55e", "what a profile's Default swatch shows");
  assert.equal(root.getAttribute("style"), null);
  applyBubble(doc, "red; background: url(x)", null);
  assert.equal(root.hasAttribute("data-t3plus-bubble"), false, "not a color: T3's bubbles");
  assert.equal(bubble("--t3plus-bubble"), "");
  applyBubble(doc, "#3b82f6");
  clearBubble(doc);
  assert.equal(root.hasAttribute("data-t3plus-bubble"), false);
  assert.equal(bubble("--t3plus-bubble"), "", "nothing left behind");
  assert.equal(root.getAttribute("style") ?? "", "");
});
