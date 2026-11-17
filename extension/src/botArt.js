import { BOT_COLORS, BOT_SHAPES, BOT_SKINS, BOT_STYLES } from "./config.js";
import { bayerThreshold } from "./ditherMath.js";

// Bot avatar art: 24x24 pixel-art faces, built as SVG sprite sheets and cached
// per (color, shape, mood). The body is an ordered-dither gradient: every
// pixel is exactly one of the color's three stops, and a 16x16 Bayer
// threshold decides which (the same technique as the background). Two white
// pixel eyes sit at the shape's visual center and change with the bot's mood.
//
// Animated moods are horizontal sprite sheets; CSS steps through the frames
// (content.css, @keyframes t3plus-bot-sprite). Static moods are one frame.

export const BOT_GRID = 24;

/** Row status (bots.js parseRowStatus) -> face. "awake" is the neutral face used in Settings. */
export const MOOD_BY_STATUS = Object.freeze({
  idle: "idle",
  working: "working",
  waiting: "waiting",
  attention: "attention",
  failed: "failed",
  done: "done",
});

const BASE_LIGHT = [0.3, 0.26];

/**
 * Frames per mood. light: highlight position (0..1); eyes: glyph; dx/dy: eye
 * offset in cells; phase: shifts the dither threshold (makes the pixels
 * shimmer between frames); boost: brightens the ramp (a pulse).
 */
const MOODS = {
  awake: { duration: 0, frames: [{ eyes: "open" }] },
  idle: { duration: 0, frames: [{ eyes: "open", boost: -0.12 }] },
  waiting: { duration: 0, frames: [{ eyes: "lidded", dx: 1 }] },
  done: { duration: 0, frames: [{ eyes: "happy", boost: 0.08 }] },
  failed: { duration: 0, frames: [{ eyes: "x", boost: -0.22 }] },
  // Busy: the light orbits the body, the dither shimmers and the eyes look around (with a blink).
  working: {
    duration: 1.6,
    frames: [0, 1, 2, 3, 4, 5, 6, 7].map((f) => {
      const a = (f / 8) * Math.PI * 2 + Math.PI * 1.25;
      return {
        light: [0.5 + 0.24 * Math.cos(a), 0.5 + 0.24 * Math.sin(a)],
        eyes: f === 6 ? "closed" : "open",
        dx: [-1, -1, 0, 1, 1, 0, 0, 0][f],
        phase: f * 3,
      };
    }),
  },
  // Needs you: wide eyes that hop, a soft pulse, and a quick blink.
  attention: {
    duration: 1.4,
    frames: [0, 1, 2, 3, 4, 5, 6, 7].map((f) => ({
      eyes: f === 5 ? "closed" : "wide",
      dy: f === 1 || f === 2 ? -1 : 0,
      boost: f < 3 ? 0.14 : 0,
    })),
  },
};

/** Stop index (0 light, 1 mid, 2 dark) for pixel x,y of a frame. Exported for tests. */
export function ditherIndex(x, y, { light = BASE_LIGHT, phase = 0, boost = 0 } = {}) {
  const cx = (x + 0.5) / BOT_GRID - light[0];
  const cy = (y + 0.5) / BOT_GRID - light[1];
  const t = Math.max(0, Math.min(1, Math.hypot(cx, cy) / 0.95 - boost));
  const v = t * 2; // two bands: light->mid, mid->dark
  const band = Math.min(1, Math.floor(v));
  return v - band > bayerThreshold(x + phase, y + phase * 2) ? band + 1 : band;
}

// Eye boxes per shape on the 24-grid: [left x, right x, top y, width, height].
// Triangles and stars carry their visual center lower / tighter.
const EYES = {
  circle: [7, 14, 9, 3, 5],
  square: [7, 14, 9, 3, 5],
  hexagon: [7, 14, 9, 3, 5],
  diamond: [7, 14, 9, 3, 5],
  triangle: [8, 13, 13, 3, 5],
  star: [9, 13, 10, 2, 4],
  ghost: [7, 14, 8, 3, 5],
  cat: [7, 14, 11, 3, 5], // below the ears
  robot: [7, 14, 9, 3, 5], // in the head, under the antenna
  heart: [7, 14, 7, 3, 4], // in the two lobes
  shield: [7, 14, 7, 3, 5],
  drop: [8, 13, 13, 3, 5], // in the belly
  octagon: [7, 14, 9, 3, 5],
  pentagon: [7, 14, 10, 3, 5],
  pill: [7, 14, 9, 3, 5],
  football: [11, 16, 12, 3, 5], // on the open lower-right side, clear of the diagonal laces
  basketball: [7, 15, 9, 3, 5], // one pixel wider apart: the vertical seam runs between them
  soccer: [7, 14, 8, 3, 5],
  baseball: [7, 14, 9, 3, 5],
  tennis: [7, 14, 9, 3, 5],
  volleyball: [7, 14, 9, 3, 5],
  eightball: [7, 14, 7, 3, 5], // above the white "8" disk
  bowling: [7, 14, 10, 3, 5], // below the finger holes
  golf: [7, 14, 9, 3, 5],
  beachball: [7, 14, 9, 3, 5],
  earth: [7, 14, 9, 3, 5],
  moon: [7, 14, 9, 3, 5],
  mars: [7, 14, 10, 3, 5],
  jupiter: [7, 14, 8, 3, 5],
  saturn: [8, 13, 7, 3, 4], // on the planet, above the ring
  sun: [8, 13, 9, 3, 5],
  orange: [7, 14, 10, 3, 5],
  apple: [7, 14, 10, 3, 5],
  lemon: [7, 14, 9, 3, 5],
  watermelon: [7, 14, 9, 3, 5],
  lime: [7, 14, 10, 3, 5],
  strawberry: [7, 14, 8, 3, 5],
};

// ---------- Marking helpers (24-grid, center 12,12) ----------
const center = (x, y) => [x + 0.5 - 12, y + 0.5 - 12];
const inDisk = (x, y, cx, cy, r) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
function eachCell(fn) {
  for (let y = 0; y < BOT_GRID; y += 1) for (let x = 0; x < BOT_GRID; x += 1) fn(x, y);
}
function line(put, x0, y0, x1, y1, layer) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i += 1) put(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), layer);
}

/** Markings of the ball, planet and fruit shapes. Layer 4+ are a skin's extra colors; "t" is transparent. */
function styleMarks(shape, put) {
  switch (shape) {
    case "soccer": {
      // Black patches: one under the eyes, the rest cut off by the edge; gray seams between them.
      for (const [cx, cy, r] of [[12, 18.6, 3.3], [12, 1.4, 2.7], [1.4, 10.6, 2.7], [22.6, 10.6, 2.7], [4.2, 21.4, 2.6], [19.8, 21.4, 2.6]]) {
        eachCell((x, y) => inDisk(x, y, cx, cy, r) && put(x, y, 4));
      }
      line(put, 9, 16, 3, 12, 1);
      line(put, 14, 16, 20, 12, 1);
      line(put, 11, 4, 11, 6, 1);
      line(put, 12, 4, 12, 6, 1);
      break;
    }
    case "baseball":
    case "tennis": {
      // Two seams curving in from the sides; the baseball's in red stitches, the tennis ball's in white.
      for (let y = 0; y < BOT_GRID; y += 1) {
        const bow = Math.round(1 + 3.6 * Math.sin((Math.PI * (y + 0.5)) / BOT_GRID));
        const layer = shape === "baseball" ? 4 : 3;
        put(bow, y, layer);
        put(23 - bow, y, layer);
        if (shape === "baseball" && y % 2 === 0 && y > 1 && y < 22) {
          put(bow + 1, y, 4);
          put(22 - bow, y, 4);
        }
      }
      break;
    }
    case "volleyball": {
      // Three curved panels around a white middle (blue, yellow, white), with dark seams.
      eachCell((x, y) => {
        const [dx, dy] = center(x, y);
        const r = Math.hypot(dx, dy);
        if (r < 6.2) return;
        const a = (Math.atan2(dy, dx) + r * 0.09 + Math.PI * 2) % (Math.PI * 2);
        const sector = Math.floor((a / (Math.PI * 2)) * 3);
        const edge = Math.abs(((a / (Math.PI * 2)) * 3) % 1 - 0) < 0.07 || Math.abs(((a / (Math.PI * 2)) * 3) % 1 - 1) < 0.07;
        if (edge) put(x, y, 6);
        else if (sector === 0) put(x, y, 4);
        else if (sector === 1) put(x, y, 5);
      });
      break;
    }
    case "eightball": {
      // A white disk with an 8 under the eyes.
      eachCell((x, y) => inDisk(x, y, 12, 18.2, 3.9) && put(x, y, 3));
      for (const [x, y] of [[12, 15], [11, 16], [13, 16], [12, 17], [11, 18], [13, 18], [12, 19]]) put(x, y, 2);
      break;
    }
    case "bowling":
      // Three finger holes above the eyes.
      for (const [x, y] of [[7, 4], [11, 2], [15, 4]]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(x + dx, y + dy, 2);
      break;
    case "golf":
      // Dimples on a staggered grid.
      eachCell((x, y) => y % 3 === 1 && (x + (y % 6 === 1 ? 0 : 2)) % 4 === 1 && put(x, y, 1));
      break;
    case "beachball": {
      // Colored gores around a white cap.
      const colors = [4, null, 5, null, 6, null];
      eachCell((x, y) => {
        const [dx, dy] = center(x, y);
        if (Math.hypot(dx, dy) < 3.2) return;
        const a = (Math.atan2(dy, dx) + Math.PI * 2 + 0.3) % (Math.PI * 2);
        const layer = colors[Math.floor((a / (Math.PI * 2)) * 6)];
        if (layer) put(x, y, layer);
      });
      break;
    }
    case "earth": {
      // Continents (lit side lighter) and a few white cloud streaks.
      const land = [[6, 6, 3.6], [8.5, 10, 3], [5.5, 13, 2.2], [16.5, 15.5, 4], [18.5, 6, 2.6], [14, 19.5, 2.4], [5, 19, 2]];
      eachCell((x, y) => {
        if (!land.some(([cx, cy, r]) => inDisk(x, y, cx, cy, r))) return;
        put(x, y, Math.hypot(x - 7, y - 6) < 9 ? 4 : 5);
      });
      for (const [x0, y0, n] of [[13, 3, 4], [2, 16, 3], [16, 21, 4]]) for (let i = 0; i < n; i += 1) put(x0 + i, y0, 3);
      break;
    }
    case "moon":
      // Craters: a dark rim with a mid floor.
      for (const [cx, cy, r] of [[6, 6, 2.8], [17.5, 18, 3.2], [16.5, 5, 2], [5, 17.5, 2.2], [11, 21, 1.5]]) {
        eachCell((x, y) => {
          if (!inDisk(x, y, cx, cy, r)) return;
          put(x, y, inDisk(x, y, cx, cy, r - 1) ? 1 : 2);
        });
      }
      break;
    case "mars":
      // A white polar cap and dusty dark patches.
      eachCell((x, y) => inDisk(x, y, 12, -1.5, 5.2) && put(x, y, 3));
      for (const [cx, cy, r] of [[7, 16, 3], [17, 12, 2.4], [14, 20, 2]]) eachCell((x, y) => inDisk(x, y, cx, cy, r) && (x + y) % 2 === 0 && put(x, y, 2));
      break;
    case "jupiter":
      // Bands and the red spot.
      for (const y of [4, 5, 14, 15, 19]) for (let x = 0; x < BOT_GRID; x += 1) put(x, y, y === 19 ? 1 : 4);
      eachCell((x, y) => ((x + 0.5 - 16.5) / 3.2) ** 2 + ((y + 0.5 - 17.2) / 1.6) ** 2 <= 1 && put(x, y, 5));
      break;
    case "saturn": {
      // The planet, a tilted ring in front of its lower half, and clear sky around both.
      eachCell((x, y) => {
        const [dx, dy] = center(x, y);
        const planet = Math.hypot(dx, dy) <= 7.6;
        const e = (dx / 11.8) ** 2 + ((dy - 0.6 + dx * 0.18) / 3.4) ** 2;
        const ring = e <= 1 && e >= 0.5;
        const front = dy + dx * 0.18 > 0.4;
        if (ring && (front || !planet)) put(x, y, e > 0.78 ? 5 : 4);
        else if (!planet) put(x, y, "t");
      });
      break;
    }
    case "orange":
    case "lime":
      // Peel dots, and (orange) a stem with a leaf.
      eachCell((x, y) => (x * 7 + y * 5) % 13 === 0 && put(x, y, 0));
      if (shape === "orange") {
        put(12, 1, 5);
        put(12, 2, 5);
        for (const [x, y] of [[13, 1], [14, 1], [14, 0], [15, 0], [13, 2]]) put(x, y, 4);
      }
      break;
    case "apple":
      // A stem and a leaf in the dip at the top, and a highlight.
      for (const y of [0, 1, 2, 3]) put(12, y, 4);
      for (const [x, y] of [[13, 2], [14, 2], [14, 1], [15, 1], [16, 1], [15, 0]]) put(x, y, 5);
      for (const [x, y] of [[6, 6], [6, 7], [7, 6]]) put(x, y, 3);
      break;
    case "lemon":
      // A light shine and pores.
      eachCell((x, y) => (x * 5 + y * 3) % 17 === 0 && put(x, y, 1));
      for (const [x, y] of [[7, 7], [8, 7], [7, 8]]) put(x, y, 3);
      break;
    case "watermelon":
      // Dark wavy stripes.
      eachCell((x, y) => ((x + Math.round(1.6 * Math.sin((Math.PI * y) / 12)) + 24) % 6 === 0) && put(x, y, 2));
      break;
    case "strawberry":
      // Yellow seeds and a green crown.
      eachCell((x, y) => y > 4 && y % 3 === 0 && (x + (y % 6 === 0 ? 1 : 3)) % 4 === 0 && put(x, y, 4));
      for (const [x, y] of [[9, 0], [10, 1], [11, 1], [12, 0], [12, 1], [13, 1], [14, 1], [15, 0], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2], [15, 2], [16, 2]]) put(x, y, 5);
      break;
    default:
  }
}

/**
 * Fixed markings of a shape (the balls' laces and seams, the robot's mouth,
 * the cat's nose), drawn over the dither and under the eyes: "x,y" -> layer
 * (2 = dark stop, 3 = white). Empty for plain shapes. Exported for tests.
 */
export function skinMarks(shape) {
  const marks = new Map();
  const put = (x, y, layer) => {
    if (x >= 0 && x < BOT_GRID && y >= 0 && y < BOT_GRID) marks.set(`${x},${y}`, layer);
  };
  if (shape === "robot") {
    // A mouth grille and a lit antenna tip.
    for (let x = 8; x <= 15; x += 1) put(x, 18, x % 2 === 0 ? 2 : 3);
    put(11, 0, 3);
    put(12, 0, 3);
  } else if (shape === "cat") {
    // A small nose and mouth under the eyes.
    put(11, 17, 2);
    put(12, 17, 2);
    put(10, 18, 2);
    put(13, 18, 2);
  } else if (shape === "football") {
    // Laces on the diagonal ball: one stitch line along the long axis, set off
    // toward the upper-left side, with four cross stitches across it.
    for (let t = -4; t <= 4; t += 1) {
      put(8 + t, 8 - t, 3);
      if (t > -4) put(8 + t, 9 - t, 3); // thicken the diagonal so it reads at 32px
    }
    for (const t of [-3, -1, 1, 3]) {
      put(7 + t, 7 - t, 3);
      put(10 + t, 10 - t, 3);
    }
  } else if (Object.hasOwn(BOT_SKINS, shape) && shape !== "basketball") {
    styleMarks(shape, put);
  } else if (shape === "basketball") {
    // Seams: a vertical seam between the eyes, an equator curved like a
    // smile below them, and the two curved side seams.
    for (let y = 0; y < BOT_GRID; y += 1) put(12, y, 2);
    for (let x = 0; x < BOT_GRID; x += 1) put(x, Math.round(13.5 + 3.5 * (1 - ((x - 12) / 12) ** 2)), 2);
    for (let y = 0; y < BOT_GRID; y += 1) {
      const bow = Math.round(0.5 + 2.5 * Math.sin((Math.PI * (y + 0.5)) / BOT_GRID));
      put(bow, y, 2);
      put(24 - bow, y, 2);
    }
  }
  return marks;
}

/** Cells of one eye, relative to its box, for a glyph. */
function eyeGlyph(glyph, w, h) {
  const cells = [];
  const pill = (top, rows, cutTop = true) => {
    for (let dy = 0; dy < rows; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const edgeRow = (cutTop && dy === 0) || dy === rows - 1;
        if (w >= 3 && edgeRow && (dx === 0 || dx === w - 1)) continue;
        cells.push([dx, top + dy]);
      }
    }
  };
  switch (glyph) {
    case "closed":
      for (let dx = 0; dx < w; dx += 1) cells.push([dx, h - 2]);
      break;
    case "lidded": // half-closed, looking sideways: flat top lid
      pill(2, h - 2, false);
      break;
    case "wide":
      pill(-1, h + 1);
      break;
    case "happy": // ^ ^
      cells.push([0, 2], [0, 3], [1, 1], [w - 1, 2], [w - 1, 3]);
      break;
    case "x":
      cells.push([0, 1], [2, 1], [1, 2], [0, 3], [2, 3]);
      break;
    default:
      pill(0, h);
  }
  return cells;
}

/** Cells of both eyes as "x,y" strings for a frame. */
export function eyeCells(shape, frame = { eyes: "open" }) {
  const [lx, rx, top, w, h] = EYES[shape] ?? EYES.circle;
  const dx = frame.dx ?? 0;
  const dy = frame.dy ?? 0;
  const cells = new Set();
  for (const x0 of [lx, rx]) {
    for (const [cx, cy] of eyeGlyph(frame.eyes ?? "open", w, h)) cells.add(`${x0 + cx + dx},${top + cy + dy}`);
  }
  return cells;
}

/** Cells touching an eye (4-neighbourhood) that are not part of it. */
export function eyeOutline(eyes) {
  const out = new Set();
  for (const cell of eyes) {
    const [x, y] = cell.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = `${x + dx},${y + dy}`;
      if (!eyes.has(next)) out.add(next);
    }
  }
  return out;
}

/** SVG path data with horizontal runs merged ("M x y h n v1 h-n z"), keeping sprites small. */
function runsPath(rows, offsetX) {
  let d = "";
  for (const [y, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j += 1;
      d += `M${xs[i] + offsetX} ${y}h${j - i + 1}v1h-${j - i + 1}z`;
      i = j + 1;
    }
  }
  return d;
}

const cache = new Map();

// In the browser the sprites are encoded as tiny PNGs (about 1-2 KB, against
// up to ~40 KB of per-pixel SVG paths for an 8-frame animation): the content
// script registers a canvas encoder here. Without one (Node tests) the SVG
// is used. The encoder gets one palette index per pixel and the palette.
let pixelEncoder = null;
export function setBotArtEncoder(encode) {
  pixelEncoder = typeof encode === "function" ? encode : null;
  cache.clear();
  badgeCache.clear();
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const mixHex = (hex, toward, t) =>
  `#${[1, 3, 5].map((i) => Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (1 - t) + toward * t).toString(16).padStart(2, "0")).join("")}`;

/**
 * The light -> mid -> dark ramp for a bot color: one of the named ramps
 * (BOT_COLORS), or one built around any #rrggbb (a project's badge color).
 */
export function botStops(color) {
  if (Object.hasOwn(BOT_COLORS, color ?? "")) return BOT_COLORS[color].stops;
  if (typeof color === "string" && HEX_COLOR.test(color)) return [mixHex(color, 255, 0.55), color.toLowerCase(), mixHex(color, 0, 0.62)];
  return BOT_COLORS.blue.stops;
}

/** Whether `shape` brings its own colors (BOT_SKINS), so the bot's color is unused. */
export function botShapeHasOwnColors(shape) {
  return Object.hasOwn(BOT_SKINS, shape ?? "");
}

/**
 * The face for (color, shape, mood). Ball shapes (BOT_SKINS) ignore `color`.
 * @returns {{ url: string, frames: number, duration: number }} url is a CSS url("data:...").
 */
export function botArt(color, shape = "circle", mood = "awake") {
  const s = Object.hasOwn(BOT_SHAPES, shape) ? shape : "circle";
  const skin = Object.hasOwn(BOT_SKINS, s) ? BOT_SKINS[s] : null;
  // A ball shape has its own colors: the bot's color does not change it.
  const c = skin ? "" : Object.hasOwn(BOT_COLORS, color ?? "") ? color : typeof color === "string" && HEX_COLOR.test(color) ? color.toLowerCase() : "blue";
  const m = Object.hasOwn(MOODS, mood) ? mood : "awake";
  const key = `${c}:${s}:${m}`;
  if (cache.has(key)) return cache.get(key);
  const stops = skin ? skin.stops : botStops(c);
  const marks = skinMarks(s);
  const { frames, duration } = MOODS[m];
  // Palette: 3 stops, white (eyes), a skin's extra colors, and transparent (sky around a ringed planet).
  const hasSky = [...marks.values()].includes("t");
  const fills = [...stops, "#ffffff", ...(skin?.extra ?? []), ...(hasSky ? ["transparent"] : [])];
  const clear = hasSky ? fills.length - 1 : -1;
  const layers = fills.map(() => new Map());
  let d = fills.map(() => "");
  const width = BOT_GRID * frames.length;
  const pixels = new Uint8Array(width * BOT_GRID);
  frames.forEach((frame, f) => {
    const eyes = eyeCells(s, frame);
    const lit = skin?.lift ? { ...frame, boost: (frame.boost ?? 0) + skin.lift } : frame;
    const outline = eyeOutline(eyes);
    for (const layer of layers) layer.clear();
    for (let y = 0; y < BOT_GRID; y += 1) {
      for (let x = 0; x < BOT_GRID; x += 1) {
        const cell = `${x},${y}`;
        // Eyes are white with a 1-pixel outline in the darkest stop, so they read on any part of the gradient.
        const mark = marks.get(cell);
        const index = eyes.has(cell) ? 3 : outline.has(cell) ? (skin?.outline ?? 2) : mark === "t" ? clear : (mark ?? ditherIndex(x, y, lit));
        pixels[y * width + f * BOT_GRID + x] = index;
        const row = layers[index].get(y) ?? [];
        row.push(x);
        layers[index].set(y, row);
      }
    }
    d = d.map((path, i) => path + runsPath(layers[i], f * BOT_GRID));
  });
  let encoded = null;
  try {
    encoded = pixelEncoder?.(pixels, width, BOT_GRID, fills) ?? null;
  } catch {
    encoded = null;
  }
  let url;
  if (encoded) url = `url("${encoded}")`;
  else {
    const body = d.map((path, i) => (path && i !== clear ? `<path fill="${fills[i]}" d="${path}"/>` : "")).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${BOT_GRID}" shape-rendering="crispEdges">${body}</svg>`;
    url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  const art = { url, frames: frames.length, duration };
  cache.set(key, art);
  return art;
}

/** The neutral (eyes open) face as a CSS url(): Settings swatches. */
export function botFillUrl(color, shape = "circle") {
  return botArt(color, shape, "awake").url;
}

/** clip-path value for `shape`. */
export function botClipPath(shape) {
  return BOT_SHAPES[shape] ?? BOT_SHAPES.circle;
}

/** Ring/edge color for an avatar: the color's mid stop (a ball shape's own mid stop). */
export function botEdgeColor(color, shape) {
  if (botShapeHasOwnColors(shape)) return BOT_SKINS[shape].stops[1];
  return botStops(color)[1];
}

// ---------- Status badge ----------
// A 9x9 pixel tile at the avatar's corner that says what the thread is doing,
// at the same pixel size as the face: a colored tile with a dark rim and one
// white glyph. It draws the eye in proportion: a thread that needs you hops,
// a working one ticks through three dots, the rest sit still.

export const BADGE_W = 9;
/** One spare row above the tile, so the "needs you" badge can hop by a pixel. */
export const BADGE_H = 10;

const BADGE_TONES = {
  attention: ["#fcd34d", "#f59e0b"],
  working: ["#93c5fd", "#3b82f6"],
  waiting: ["#cbd5e1", "#64748b"],
  done: ["#86efac", "#22c55e"],
  failed: ["#fca5a5", "#ef4444"],
  idle: ["#a1a1aa", "#52525b"],
};

// 5x5 glyphs, drawn in the tile's 7x7 inside with a one-pixel margin.
const BADGE_GLYPHS = {
  question: [".###.", "...#.", "..#..", ".....", "..#.."],
  exclaim: ["..#..", "..#..", "..#..", ".....", "..#.."],
  check: [".....", "....#", "#..#.", ".##..", "....."],
  cross: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  pause: [".#.#.", ".#.#.", ".#.#.", ".#.#.", ".#.#."],
  sleep: ["####.", "...#.", "..#..", ".#...", "####."],
};

/** T3's status label -> glyph for a thread that needs you: a question to answer, or something to approve / look at. */
const ATTENTION_GLYPH = { Input: "question", Request: "question", Approval: "exclaim", Woke: "exclaim" };

/** Frames for a status: { glyph | dots, hop } per frame. Exported for tests. */
export function badgeFrames(status, label = "") {
  switch (status) {
    case "attention": {
      const glyph = ATTENTION_GLYPH[label] ?? "exclaim";
      return { duration: 1, frames: [{ glyph }, { glyph }, { glyph, hop: true }, { glyph }] };
    }
    case "working":
      return { duration: 1.2, frames: [{ dots: 0 }, { dots: 1 }, { dots: 2 }, { dots: -1 }] };
    case "waiting":
      return { duration: 0, frames: [{ glyph: "pause" }] };
    case "done":
      return { duration: 0, frames: [{ glyph: "check" }] };
    case "failed":
      return { duration: 0, frames: [{ glyph: "cross" }] };
    default:
      return { duration: 0, frames: [{ glyph: "sleep" }] };
  }
}

/** Palette index per pixel of one badge frame: 0 clear, 1 rim, 2 light, 3 tone, 4 white. Exported for tests. */
export function badgePixels(frame) {
  const out = new Uint8Array(BADGE_W * BADGE_H);
  const top = frame.hop ? 0 : 1;
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const edgeX = x === 0 || x === 8;
      const edgeY = y === 0 || y === 8;
      if (edgeX && edgeY) continue; // cut corners: a rounded tile
      let index = edgeX || edgeY ? 1 : y === 1 || x === 1 ? 2 : 3; // rim, then a lit top and left edge
      const gx = x - 2;
      const gy = y - 2;
      if (gx >= 0 && gx < 5 && gy >= 0 && gy < 5) {
        if (frame.glyph) {
          if (BADGE_GLYPHS[frame.glyph][gy][gx] === "#") index = 4;
        } else if (gx % 2 === 0) {
          // Three dots; the active one is raised.
          const dot = gx / 2;
          if (gy === (dot === frame.dots ? 1 : 2)) index = 4;
        }
      }
      out[(top + y) * BADGE_W + x] = index;
    }
  }
  return out;
}

const badgeCache = new Map();

/**
 * The badge for a row status (and T3's own label, which tells a question from
 * an approval). @returns {{ url: string, frames: number, duration: number }}
 */
export function botBadge(status, label = "") {
  const tone = Object.hasOwn(BADGE_TONES, status ?? "") ? status : "idle";
  const { frames, duration } = badgeFrames(tone, label);
  const key = `${tone}:${frames.map((f) => `${f.glyph ?? f.dots}${f.hop ? "^" : ""}`).join(",")}:${pixelEncoder ? "p" : "s"}`;
  if (badgeCache.has(key)) return badgeCache.get(key);
  const fills = ["transparent", "#0a0a0a", ...BADGE_TONES[tone], "#ffffff"];
  const width = BADGE_W * frames.length;
  const pixels = new Uint8Array(width * BADGE_H);
  frames.forEach((frame, f) => {
    const cells = badgePixels(frame);
    for (let y = 0; y < BADGE_H; y += 1) for (let x = 0; x < BADGE_W; x += 1) pixels[y * width + f * BADGE_W + x] = cells[y * BADGE_W + x];
  });
  let encoded = null;
  try {
    encoded = pixelEncoder?.(pixels, width, BADGE_H, fills) ?? null;
  } catch {
    encoded = null;
  }
  let url;
  if (encoded) url = `url("${encoded}")`;
  else {
    let body = "";
    for (let i = 0; i < pixels.length; i += 1) {
      if (pixels[i]) body += `<rect x="${i % width}" y="${Math.floor(i / width)}" width="1" height="1" fill="${fills[pixels[i]]}"/>`;
    }
    url = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${BADGE_H}" shape-rendering="crispEdges">${body}</svg>`)}")`;
  }
  const art = { url, frames: frames.length, duration };
  badgeCache.set(key, art);
  return art;
}

// The style bots without a picked shape follow (Settings -> t3+ -> Bot style).
let botStyle = "classic";
export function setBotStyle(style) {
  botStyle = Object.hasOwn(BOT_STYLES, style ?? "") ? style : "classic";
}
export function currentBotStyle() {
  return botStyle;
}

const styleShapes = () => BOT_STYLES[botStyle]?.shapes ?? Object.keys(BOT_SHAPES).filter((n) => !Object.hasOwn(BOT_SKINS, n));
const keyHash = (key) => {
  let hash = 7;
  for (const ch of String(key)) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return hash;
};

// The bots on screen get different shapes while the set has enough: each takes
// its hashed shape, or the next free one. Keys are taken in a fixed order, so
// a bot keeps its shape while the others come and go less often than not.
let assigned = new Map();
let assignedFor = "";
export function assignBotShapes(keys) {
  const names = styleShapes();
  const sorted = [...new Set(keys)].sort();
  const signature = `${botStyle}|${sorted.join(",")}`;
  if (signature === assignedFor) return;
  assignedFor = signature;
  assigned = new Map();
  const used = new Set();
  for (const key of sorted) {
    let i = keyHash(key) % names.length;
    if (used.size < names.length) while (used.has(names[i])) i = (i + 1) % names.length;
    used.add(names[i]);
    assigned.set(key, names[i]);
  }
}

/** A stable default shape for a bot that has none picked, so bots do not all look alike: from the current style's set. */
export function defaultBotShape(key) {
  const names = styleShapes();
  const picked = assigned.get(key);
  if (picked && names.includes(picked)) return picked;
  return names[keyHash(key) % names.length];
}

/** A stable default color for a bot that has none saved, so new bots differ. */
export function defaultBotColor(key) {
  const names = Object.keys(BOT_COLORS).filter((n) => n !== "gray");
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return names[hash % names.length];
}
