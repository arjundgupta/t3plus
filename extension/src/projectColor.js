import { cssColorBytes } from "./color.js";
import { T3_SELECTORS } from "./config.js";

// The color of a thread's project, read from the badge T3 already draws for it
// (the letter tile next to the project name). Bots use it as their own color.
// Read-only: nothing is drawn into or changed on T3's badge.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const cache = new Map(); // badge src -> "#rrggbb" | null

/** "#abc" / "#AABBCC" -> "#aabbcc"; anything else -> null. */
export function normalizeHex(value) {
  if (typeof value !== "string" || !HEX.test(value.trim())) return null;
  const v = value.trim().toLowerCase();
  return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
}

/** The tile color in one of T3's letter badges (an SVG with a filled <rect>). */
export function svgTileColor(svgText) {
  const fill = /<rect\b[^>]*\bfill="([^"]+)"/i.exec(svgText ?? "")?.[1];
  return normalizeHex(fill);
}

/** Average color of a project's own icon (a favicon), or null when it cannot be read. */
function imageColor(img) {
  try {
    if (!img.complete || !img.naturalWidth) return null;
    const canvas = img.ownerDocument.createElement("canvas");
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 8);
    const { data } = ctx.getImageData(0, 0, 8, 8);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
    if (!n) return null;
    return `#${[r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null; // a cross-origin icon: its pixels are not ours to read
  }
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> "#010203"; fully transparent -> null (no color). */
const rgb = (css) => {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+)(%?))?/i.exec(css ?? "");
  if (!m) return undefined;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return alpha > 0 ? toHex(m[1], m[2], m[3]) : null;
};
const cssCache = new Map(); // computed CSS color -> "#rrggbb" | null

/**
 * Any computed CSS color ("oklch(...)", "rgb(...)", a hex) as "#rrggbb", or null
 * when it is transparent or unknown. The browser converts it (color.js).
 */
export function cssColorToHex(doc, css) {
  if (!css) return null;
  const plain = normalizeHex(css) ?? rgb(css);
  if (plain !== undefined) return plain;
  if (cssCache.has(css)) return cssCache.get(css);
  const bytes = cssColorBytes(doc, css);
  const hex = bytes && bytes[3] > 0 ? toHex(bytes[0], bytes[1], bytes[2]) : null;
  if (cssCache.size > 100) cssCache.clear();
  cssCache.set(css, hex);
  return hex;
}

// A monogram's computed color, per class list and theme: every check asks for every
// bot's project color, and a computed style read for each was a style recalc each.
const monogramCache = new Map();

function badgeColor(badge) {
  if (!badge) return null;
  if (badge.tagName?.toLowerCase() !== "img") {
    const fill = badge.querySelector?.("rect[fill]")?.getAttribute("fill");
    if (fill) return normalizeHex(fill);
    // T3's monogram (<span data-slot="project-monogram"><svg class="text-lime-600 ...">):
    // no filled rect any more; the tile is the svg's text color (currentColor).
    const svg = badge.matches?.("svg") ? badge : badge.querySelector?.("svg");
    const doc = badge.ownerDocument;
    if (!svg || !doc?.defaultView) return null;
    const root = doc.documentElement;
    const key = `${svg.getAttribute("class") ?? ""}|${svg.getAttribute("style") ?? ""}|${root.className}|${root.getAttribute("data-theme-id") ?? ""}`;
    if (monogramCache.has(key)) return monogramCache.get(key);
    const color = cssColorToHex(doc, doc.defaultView.getComputedStyle(svg).color);
    if (monogramCache.size > 200) monogramCache.clear();
    monogramCache.set(key, color);
    return color;
  }
  const src = badge.getAttribute("src") ?? "";
  if (!src) return null;
  if (cache.has(src)) return cache.get(src);
  let color = null;
  const prefix = "data:image/svg+xml;base64,";
  if (src.startsWith(prefix)) {
    try {
      color = svgTileColor(atob(src.slice(prefix.length)));
    } catch {
      color = null;
    }
  } else if (src.startsWith("data:image/svg+xml,")) {
    try {
      color = svgTileColor(decodeURIComponent(src.slice("data:image/svg+xml,".length)));
    } catch {
      color = null;
    }
  } else {
    color = imageColor(badge);
    if (color === null && !badge.complete) return null; // not loaded yet: ask again later
  }
  if (cache.size > 200) cache.clear();
  cache.set(src, color);
  return color;
}

/**
 * The project color for a thread from a sidebar scan: its folder's badge in the
 * project-grouped sidebar, or the badge on the row's own project line in the
 * flat one. Null when the project has no colored badge ("No project").
 */
export function threadProjectColor(scan, thread) {
  const folderRow = thread.folderKey !== null && thread.folderKey !== undefined ? scan.folders.get(thread.folderKey)?.row : null;
  // A settled or snoozed row outside a folder is slim and carries its project's
  // badge in its one line: without reading it, a bot changed color when it settled.
  const host = folderRow ?? thread.row?.querySelector?.(T3_SELECTORS.cardRowTopLine) ?? thread.row?.querySelector?.(T3_SELECTORS.slimRowBadgeSlot);
  if (!host) return null;
  return badgeColor(host.querySelector(T3_SELECTORS.projectBadge));
}
