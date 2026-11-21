import { DITHER_CELL_CSS } from "./backdropRenderer.js";
import { botBadge, botClipPath, botEdgeColor, botStill, MOOD_BY_STATUS } from "./botArt.js";
import { applyAvatarVars, subagentFace, subagentMini } from "./bots.js";
import { ditherLevel, GLOW_SHAPE, glowStrength, thresholdFor } from "./ditherMath.js";
import { setAttr, setVar } from "./dom.js";
import { BOT_STATUS, BOT_STATUS_COLORS, STATUS_GROUPS } from "./statusView.js";

// Small pictures beside some of Settings → t3+'s choices, where seeing one says more than
// its words. Every one is still: drawn on the panel's first update and again only when the
// setting it shows changes, so none is stepped by the sprite clock or costs anything per
// frame. Each is decorative (aria-hidden): its row's title and description say the same.

/** The bot the samples show: a plain face in a color of its own. */
const SAMPLE_BOT = Object.freeze({ shape: "circle", color: "purple" });

/** The glow color as CSS: "theme" is T3's own (its primary). */
export const glowColorCss = (accent) => (accent === "theme" ? "var(--primary, #6d7cff)" : accent);

/** A face that stands still, as one of t3+'s avatars draws it (applyAvatarVars): one frame, so never stepped. */
function stillView(color, shape, mood, badge = null) {
  return { fill: botStill(color, shape, mood).url, clip: botClipPath(shape), edge: botEdgeColor(color, shape), frames: 1, duration: 0, shape, mood, badge };
}

// ---------- Look and Pixel size: a pinch of the glow ----------
// 24×12 CSS px: a whole number of cells at every pixel size (4/3, 2 and 3 px).
const SWATCH_W = 24;
const SWATCH_H = 12;
// How opaque each dither level is. The mask lets the glow color through, so the low
// levels read as the dark ramp's deep tones on a dark page and as the light ramp's pale
// tints on a light one, as the real glow's do.
const LEVEL_ALPHA = [0, 0.4, 0.65, 0.85, 1];
// Closed in on the glow's core and the edge of its halo: the whole glow in 24×12 px was a
// few dots at the bottom, and Bayer could not be told from Grain.
const SPAN_X = GLOW_SHAPE.coreRx * 2.4;
const SPAN_Y = GLOW_SHAPE.coreRy * 1.4;
const SWATCH_INTENSITY = 0.6;
const masks = new Map(); // "look:size" -> CSS url(): at most 3 × 3, each a few hundred bytes

/** The dither level of cell (x, y) in a swatch `cols` × `rows` cells. */
function swatchLevel(x, y, cols, rows, threshold) {
  const u = 0.5 + ((x + 0.5) / cols - 0.5) * SPAN_X;
  const v = 1 - (1 - (y + 0.5) / rows) * SPAN_Y;
  const strength = glowStrength(u, v, 0.5, SWATCH_INTENSITY);
  return strength > 0 ? ditherLevel(Math.min(strength, 0.9), LEVEL_ALPHA.length, threshold(x, y)) : 0;
}

/** A row of cells as rects, one per run of the same level. */
function rowRects(levels, y) {
  let out = "";
  for (let x = 0; x < levels.length; ) {
    let end = x + 1;
    while (end < levels.length && levels[end] === levels[x]) end += 1;
    if (levels[x]) out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill-opacity="${LEVEL_ALPHA[levels[x]]}"/>`;
    x = end;
  }
  return out;
}

/**
 * The swatch for a dithered `look` ("bayer", "grain" or "spectrum") at pixel `size`, as a
 * CSS mask url(): the same glow, thresholds and cell size the background uses.
 */
export function ditherSwatchMask(look, size) {
  const key = `${look}:${size}`;
  if (!masks.has(key)) {
    const cell = DITHER_CELL_CSS[size] ?? DITHER_CELL_CSS.medium;
    const cols = Math.round(SWATCH_W / cell);
    const rows = Math.round(SWATCH_H / cell);
    const threshold = thresholdFor(look);
    let rects = "";
    for (let y = 0; y < rows; y += 1) rects += rowRects(Array.from({ length: cols }, (_, x) => swatchLevel(x, y, cols, rows, threshold)), y);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols} ${rows}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
    masks.set(key, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  }
  return masks.get(key);
}

/** One swatch, for a segment of Look or Pixel size: blank until painted, which sets its data-look too. */
export const glowSwatch = (h) => h("span", { class: "t3plus-glow-swatch", "aria-hidden": "true" });

/** Paints a swatch: `look` at `size`, in the glow color (Smooth is a gradient: content.css). */
function paintSwatch(el, look, size, glow) {
  setAttr(el, "data-look", look);
  setVar(el, "--t3plus-swatch-mask", look === "smooth" ? null : ditherSwatchMask(look, size));
  setVar(el, "--t3plus-swatch-glow", glow);
}

/**
 * The Look and Pixel size swatches (`looks`, `sizes`: value -> swatch). Each look at the
 * pixel size set, each size in the look set; all in the glow color of the scope edited.
 */
export function createGlowSwatches(looks, sizes) {
  let shown = "";
  return ({ look, size, accent }) => {
    const glow = glowColorCss(accent);
    const signature = `${look}|${size}|${glow}`;
    if (signature === shown) return;
    shown = signature;
    for (const [value, el] of looks) paintSwatch(el, value, size, glow);
    // Smooth has no pixels: its sizes are hidden with their row, and keep what they showed.
    if (look !== "smooth") for (const [value, el] of sizes) paintSwatch(el, look, value, glow);
  };
}

// ---------- Bot style: a face of each style ----------

/** An empty face for a Bot style segment, drawn by drawStyleFace. */
export const styleFace = (h) => h("i", { class: "t3plus-face-icon t3plus-segment-face", "aria-hidden": "true" });

/** Draws the style's first shape (a plain face for Classic, which has no set of its own). */
export function drawStyleFace(el, style) {
  const shape = style.shapes?.[0] ?? SAMPLE_BOT.shape;
  el.style.setProperty("--t3plus-bot-fill", botStill(SAMPLE_BOT.color, shape).url);
  el.style.setProperty("--t3plus-bot-clip", botClipPath(shape));
}

// ---------- Status colors: a face for each of the Status view's groups ----------

/**
 * The Status view's groups as faces with their names. With Status colors on each wears
 * its status's color; off, they all keep the bot's own.
 */
export function createStatusColorsSample(h) {
  // A group's face is its first status's (Needs you: attention, and so on).
  const faces = STATUS_GROUPS.map((group) => ({ status: BOT_STATUS[group.statuses[0]], el: h("span", { class: "t3plus-bot-swatch" }), label: group.label }));
  const element = h("div", { class: "t3plus-status-sample", "aria-hidden": "true" },
    faces.map(({ el, label }) => h("span", { class: "t3plus-status-sample-item" }, [el, h("span", { text: label })])));
  let shown = null;
  return {
    element,
    update(on) {
      if (on === shown) return;
      shown = on;
      for (const { status, el } of faces) applyAvatarVars(el, stillView(on ? BOT_STATUS_COLORS[status] : SAMPLE_BOT.color, SAMPLE_BOT.shape, MOOD_BY_STATUS[status]));
    },
  };
}

// ---------- Status badges: a face with its tile, or without ----------

/** A finished bot's face, with its badge's tile while Status badges is on (a still badge: Done's check). */
export function createBadgeSample(h) {
  const element = h("span", { class: "t3plus-bot-swatch t3plus-badge-sample", "aria-hidden": "true" });
  let shown = null;
  return {
    element,
    update(on) {
      if (on === shown) return;
      shown = on;
      applyAvatarVars(element, stillView(SAMPLE_BOT.color, SAMPLE_BOT.shape, "done", on ? botBadge("done") : null));
    },
  };
}

// ---------- Subagents: a bot and three of its subagents ----------

/** The bot's own face drawn once, then its subagents (running, finished, failed) in the shape and color picked. */
export function createSubagentSample(h) {
  const bot = h("span", { class: "t3plus-bot-swatch" });
  const subs = h("span", { class: "t3plus-subagent-sample-subs" });
  const element = h("span", { class: "t3plus-subagent-sample", "aria-hidden": "true" }, [bot, subs]);
  let shown = "";
  return {
    element,
    update(look) {
      const face = subagentFace({ shape: SAMPLE_BOT.shape, paint: SAMPLE_BOT.color }, look);
      const signature = `${face.shape}|${face.color}`;
      if (signature === shown) return;
      if (!shown) applyAvatarVars(bot, stillView(SAMPLE_BOT.color, SAMPLE_BOT.shape, "awake"));
      shown = signature;
      subs.replaceChildren(...["running", "completed", "failed"].map((status) => subagentMini(subs.ownerDocument, face, status)));
    },
  };
}
