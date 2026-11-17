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

function badgeColor(badge) {
  if (!badge) return null;
  if (badge.tagName?.toLowerCase() !== "img") return normalizeHex(badge.querySelector?.("rect[fill]")?.getAttribute("fill"));
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
  const host = folderRow ?? thread.row?.querySelector?.(":scope > .relative.z-10 > .h-5");
  if (!host) return null;
  return badgeColor(host.querySelector('img, [data-slot="project-monogram"] svg, [data-slot="project-monogram"]'));
}
