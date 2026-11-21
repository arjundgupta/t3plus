// Any CSS color (oklch(), color-mix(), a resolved var(), hex, rgb) as sRGB bytes:
// painted on a 1x1 canvas and read back, so the browser does the conversion.
// One probe canvas per document. Used by the glow renderer (theme colors) and by
// projectColor.js (a project badge's computed color).

const probes = new WeakMap(); // document -> 2d context

/**
 * What T3's theme on <html> is made of: its class (light/dark), data-theme, data-theme-id
 * and the inline values T3 sets there (--app-theme-*). t3+'s own inline values are left
 * out: written on a profile switch, they made every theme cache take it for a new theme.
 */
export function themeStamp(root) {
  let stamp = `${root.className}|${root.getAttribute("data-theme") ?? ""}|${root.getAttribute("data-theme-id") ?? ""}`;
  const { style } = root;
  for (let i = 0; i < style.length; i += 1) {
    const name = style[i];
    if (!name.startsWith("--t3plus-")) stamp += `|${name}:${style.getPropertyValue(name)}`;
  }
  return stamp;
}

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
