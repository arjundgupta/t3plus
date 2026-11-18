// Any CSS color (oklch(), color-mix(), a resolved var(), hex, rgb) as sRGB bytes:
// painted on a 1x1 canvas and read back, so the browser does the conversion.
// One probe canvas per document. Used by the glow renderer (theme colors) and by
// projectColor.js (a project badge's computed color).

const probes = new WeakMap(); // document -> 2d context

/**
 * [r, g, b, a] (0..255) for `css`, or null when there is no canvas. An invalid
 * color leaves `fallback` painted (transparent when none is given).
 */
export function cssColorBytes(doc, css, fallback = "rgba(0, 0, 0, 0)") {
  if (!doc || !css) return null;
  try {
    let ctx = probes.get(doc);
    if (!ctx) {
      const canvas = doc.createElement("canvas");
      canvas.width = canvas.height = 1;
      ctx = canvas.getContext?.("2d", { willReadFrequently: true }) ?? null;
      if (!ctx) return null;
      probes.set(doc, ctx);
    }
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a];
  } catch {
    return null;
  }
}
