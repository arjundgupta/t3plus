import { DITHER_STYLES, ditherRgbInPlace, glowPixelArt, glowSpriteSpan } from "./ditherMath.js";

export { DITHER_STYLES };

// Real ordered dither for the background, in the same pixel-art style as the
// bot avatars. The glow (or image) is drawn once into a small canvas at
// "dither cell" resolution, quantized to a few far-apart tones, and shown as a
// crisp, pixelated image. It is re-drawn only when something it depends on
// changes (its size, color, intensity, style, image, DPR), never per frame.
// Until a render is ready (or if one fails) the plain CSS gradient from
// content.css shows instead.
//
// The image lives in t3+'s own layer, the first child of the host pane:
//   div.t3plus-glow                 inset 0 behind the pane's content
//     div.t3plus-glow-pos           translated to the glow center
//       div.t3plus-glow-near        the glow sprite (a thread)
//       div.t3plus-glow-wide        the wider sprite (the new-thread page)
// Moving or resizing the glow restyles only these leaf elements. (It used to
// be custom properties on <html>, and every change restyled the whole page:
// about 30 ms a time, many times while a panel opened or the glow slid.)
// On <html> only data-t3plus-dithered="<mode>" is set, once per mode, so the
// pane's CSS-gradient fallback steps aside while the layer shows.

/** How much wider the glow spreads on the new-thread page than in a thread. */
export const HERO_SPREAD = 1.15;

/**
 * The glow's size as shares of the message box's width: halo radii, how far
 * its center sits below the pane, how far out (as a share of the halo) dots
 * are still visible,
 * and the pane width assumed when no message box is known (Settings preview).
 */
export const GLOW_BOX = Object.freeze({ rx: 0.76, ry: 0.5, drop: 0.063, reach: 0.96, paneW: 1.7 });

/**
 * Dither cell size in CSS px. "fine" matches one pixel of a 32 px bot avatar
 * (32 / 24 px). Sizes are in CSS px, not device px: on a 2x Retina display a
 * 2-device-pixel cell was only 1 CSS px and the dither vanished.
 */
export const DITHER_CELL_CSS = Object.freeze({ fine: 4 / 3, medium: 2, large: 3 });
/** Upper bound on rendered cells, so a huge window never costs more than a few ms. */
const MAX_CELLS = 1_200_000;

/** Cell size in CSS px (a whole number of device px) and canvas size for a pane. Exported for tests. */
export function ditherGrid(width, height, dpr, cellCss = DITHER_CELL_CSS.medium) {
  // Whole device pixels keep every cell the same size; never below 2 device px.
  let cellDevice = Math.max(2, Math.round(cellCss * dpr));
  while ((width * dpr * height * dpr) / (cellDevice * cellDevice) > MAX_CELLS) cellDevice += 1;
  const cell = cellDevice / dpr;
  return { cell, cols: Math.ceil(width / cell), rows: Math.ceil(height / cell) };
}

export function createBackdropRenderer({ win, doc, delayMs = 120 }) {
  const root = doc.documentElement;
  let lastKey = null;
  let scheduledKey = null;
  let timer = null;
  let url = null;
  let wideUrl = null;
  let generation = 0;
  let shown = null; // { url, wideUrl, mode, w, h, wideW, wideH } of the last render
  const imageCache = new Map(); // src -> Promise<HTMLImageElement>

  // ---- Colors: resolve any CSS color (oklch, var(), color-mix) to sRGB bytes ----
  let probeCanvas = null;
  const rgbCache = new Map(); // css color -> [r, g, b]
  function toRgb(cssColor, fallback) {
    const key = `${cssColor}|${fallback}`;
    if (rgbCache.has(key)) return rgbCache.get(key);
    const rgb = paintRgb(cssColor, fallback);
    if (rgbCache.size > 32) rgbCache.clear();
    if (rgb) rgbCache.set(key, rgb);
    return rgb;
  }
  function paintRgb(cssColor, fallback) {
    try {
      probeCanvas ??= doc.createElement("canvas");
      probeCanvas.width = probeCanvas.height = 1;
      const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = fallback;
      ctx.fillStyle = cssColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    } catch {
      return null;
    }
  }
  // A theme color (T3's --primary or --background) is read from the computed
  // custom property, which already has any var() resolved; the canvas then
  // turns oklch(), color-mix() or hex into bytes. No probe element: adding one
  // to the pane was a DOM change of its own.
  const colorCache = new Map(); // name -> { stamp, at, value }
  const COLOR_TTL_MS = 3000;
  function themeColor(name, fallback, el) {
    const stamp = `${root.className}|${root.getAttribute("data-theme") ?? ""}|${root.style.colorScheme}`;
    const at = win.performance?.now?.() ?? Date.now();
    const hit = colorCache.get(name);
    if (hit && hit.stamp === stamp && at - hit.at < COLOR_TTL_MS) return hit.value;
    const value = win.getComputedStyle(el ?? root).getPropertyValue(name).trim() || fallback;
    colorCache.set(name, { stamp, at, value });
    return value;
  }

  // ---- The layer ----
  let layer = null;
  let pos = null;
  let nearEl = null;
  let wideEl = null;
  function ensureLayer(host) {
    if (!layer) {
      layer = doc.createElement("div");
      layer.className = "t3plus-glow";
      layer.setAttribute("data-t3plus-owned", "");
      layer.setAttribute("aria-hidden", "true");
      pos = doc.createElement("div");
      pos.className = "t3plus-glow-pos";
      nearEl = doc.createElement("div");
      nearEl.className = "t3plus-glow-near";
      wideEl = doc.createElement("div");
      wideEl.className = "t3plus-glow-wide";
      pos.append(nearEl, wideEl);
      layer.append(pos);
    }
    // First child, so it stays behind everything T3 renders in the pane.
    if (layer.parentElement !== host || host.firstChild !== layer) {
      const fresh = layer.parentElement !== host;
      host.insertBefore(layer, host.firstChild);
      if (fresh) {
        // A new pane (thread switch, remount): show the glow in place, without the crossfade.
        layer.removeAttribute("data-ready");
        (win.requestAnimationFrame ?? ((f) => win.setTimeout(f, 16)))(() => layer?.setAttribute("data-ready", ""));
      }
    }
    return layer;
  }
  const setStyle = (el, name, value) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };
  const px = (v) => `${v.toFixed(3)}px`;
  function showImages() {
    if (!layer || !shown) return;
    layer.setAttribute("data-kind", shown.mode);
    if (shown.mode === "half-circle") {
      setStyle(nearEl, "background-image", `url("${shown.url}")`);
      setStyle(wideEl, "background-image", shown.wideUrl ? `url("${shown.wideUrl}")` : "none");
      setStyle(layer, "background-image", "none");
    } else {
      setStyle(layer, "background-image", `url("${shown.url}")`);
      setStyle(layer, "background-size", `${px(shown.w)} ${px(shown.h)}`);
    }
    if (root.getAttribute("data-t3plus-dithered") !== shown.mode) root.setAttribute("data-t3plus-dithered", shown.mode);
  }

  function clear() {
    generation += 1;
    if (timer) win.clearTimeout(timer);
    timer = null;
    lastKey = null;
    scheduledKey = null;
    root.removeAttribute("data-t3plus-dithered");
    layer?.remove();
    layer = pos = nearEl = wideEl = null;
    if (shown && ![...renders.values()].includes(shown)) for (const u of [shown.url, shown.wideUrl]) if (u) win.URL.revokeObjectURL(u);
    forgetRenders();
    shown = null;
  }

  function loadImage(src) {
    if (!imageCache.has(src)) {
      const promise = (async () => {
        // Read through fetch into a data URL so the canvas is never tainted,
        // whatever origin the image came from (extension asset, blob, data URL).
        let dataSrc = src;
        if (!src.startsWith("data:")) {
          const blob = await (await win.fetch(src)).blob();
          dataSrc = await new Promise((resolve, reject) => {
            const reader = new win.FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }
        const img = new win.Image();
        img.decoding = "async";
        img.src = dataSrc;
        await img.decode();
        return img;
      })();
      imageCache.clear(); // keep only the current image
      imageCache.set(src, promise);
      promise.catch(() => imageCache.delete(src));
    }
    return imageCache.get(src);
  }

  /** Draws `img` like object-fit: cover (centered on the composer), then the page-color scrim. */
  function drawCoverWithScrim(ctx, img, w, h, job) {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * scale;
    const ih = img.naturalHeight * scale;
    const x = Math.min(0, Math.max(w - iw, job.cx * w - iw / 2));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x, (h - ih) / 2, iw, ih);
    const [r, g, b] = job.background;
    const scrim = ctx.createLinearGradient(0, 0, 0, h);
    scrim.addColorStop(0, `rgba(${r},${g},${b},${job.scrimTop})`);
    scrim.addColorStop(1, `rgba(${r},${g},${b},${job.scrimBottom})`);
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, w, h);
  }

  // The pixel math runs in slices of a few milliseconds with the page free in
  // between: drawn in one go (about 60 ms for both sprites) it was a frozen
  // frame whenever the glow changed size.
  const SLICE_MS = 6;
  const nowMs = () => win.performance?.now?.() ?? Date.now();
  const yieldTask = () =>
    new Promise((resolve) => {
      if (typeof win.MessageChannel === "function") {
        const channel = new win.MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      } else win.setTimeout(resolve, 0);
    });
  async function inSlices(rows, gen, fill) {
    let row = 0;
    while (row < rows) {
      const started = nowMs();
      // At least 4 rows a slice; more while the slice is under budget.
      let to = Math.min(rows, row + 4);
      fill(row, to);
      row = to;
      while (row < rows && nowMs() - started < SLICE_MS) {
        to = Math.min(rows, row + 4);
        fill(row, to);
        row = to;
      }
      if (row < rows) {
        await yieldTask();
        if (gen !== generation) return false;
      }
    }
    return true;
  }

  async function glowBlob(job, cols, rows, gen) {
    const canvas = doc.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    const pixels = new Uint8ClampedArray(cols * rows * 4);
    const options = { width: cols, height: rows, rgb: job.accent, intensity: job.intensity, style: job.style, sprite: job.sprite, out: pixels };
    if (!(await inSlices(rows, gen, (fromRow, toRow) => glowPixelArt({ ...options, fromRow, toRow })))) return null;
    ctx.putImageData(new win.ImageData(pixels, cols, rows), 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function render(job, gen) {
    if (job.mode === "half-circle") {
      // Both sprites, so switching pages never waits on a render.
      const near = await glowBlob(job, job.cols, job.rows, gen);
      if (!near || gen !== generation) return null;
      const wide = await glowBlob(job, job.wideCols, job.wideRows, gen);
      return near && wide ? { near, wide } : null;
    }
    const canvas = doc.createElement("canvas");
    canvas.width = job.cols;
    canvas.height = job.rows;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    const img = await loadImage(job.imageSrc);
    if (gen !== generation) return null;
    drawCoverWithScrim(ctx, img, job.cols, job.rows, job);
    const data = ctx.getImageData(0, 0, job.cols, job.rows);
    if (!(await inSlices(job.rows, gen, (fromRow, toRow) => ditherRgbInPlace(data.data, job.cols, job.rows, 5, job.style, fromRow, toRow)))) return null;
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? { near: blob } : null;
  }

  // The last few renders, by key: a panel toggled back and forth shows the
  // earlier images again instead of drawing them anew.
  const renders = new Map(); // key -> shown
  const KEEP_RENDERS = 4;
  function remember(key, result) {
    renders.delete(key);
    renders.set(key, result);
    while (renders.size > KEEP_RENDERS) {
      const [oldKey, old] = renders.entries().next().value;
      renders.delete(oldKey);
      if (old === shown) continue;
      // Let any paint that still uses it finish first.
      win.setTimeout(() => [old.url, old.wideUrl].forEach((u) => u && win.URL.revokeObjectURL(u)), 1000);
    }
  }
  function forgetRenders() {
    for (const r of renders.values()) for (const u of [r.url, r.wideUrl]) if (u) win.URL.revokeObjectURL(u);
    renders.clear();
  }

  function run(job, key) {
    timer = null;
    const gen = (generation += 1);
    render(job, gen)
      .then((blobs) => {
        if (!blobs || gen !== generation) return;
        shown = {
          mode: job.mode,
          url: win.URL.createObjectURL(blobs.near),
          wideUrl: blobs.wide ? win.URL.createObjectURL(blobs.wide) : null,
          w: job.cols * job.cell,
          h: job.rows * job.cell,
        };
        remember(key, shown);
        showImages();
        lastKey = key;
      })
      .catch(() => {
        if (gen !== generation) return;
        // Fall back to the CSS gradient rather than leave a stale image.
        root.removeAttribute("data-t3plus-dithered");
        layer?.remove();
        lastKey = key;
      })
      .finally(() => {
        if (scheduledKey === key) scheduledKey = null;
      });
  }

  /**
   * @param {{ mode: "half-circle" | "image" | null, settings, imageSrc: string | null,
   *           host: Element | null, cx: number, cy?: number | null, wide?: boolean,
   *           composerWidth?: number }} o  cx is 0..1 (composer center across the host);
   *   cy, when set, centers the glow vertically there (new-thread page); composerWidth is
   *   the message box's width in CSS px.
   */
  function update({ mode, settings, imageSrc, host, cx, cy = null, wide = false, composerWidth = 0 }) {
    if (!mode || !host || typeof host.getBoundingClientRect !== "function") {
      if (lastKey || scheduledKey || layer) clear();
      return;
    }
    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return; // not laid out: keep what is shown
    const dpr = win.devicePixelRatio || 1;
    const g = settings.composerGradient;
    const cellCss = DITHER_CELL_CSS[g.ditherSize] ?? DITHER_CELL_CSS.medium;
    const style = DITHER_STYLES.includes(g.ditherStyle) ? g.ditherStyle : DITHER_STYLES[0];
    const i = g.intensity / 100;
    ensureLayer(host);
    let job;
    if (mode === "half-circle") {
      // The glow is a sprite (just its halo's box) placed by a transform: where
      // it sits (composer x, bottom edge in a thread, around the composer on the
      // new-thread page) is not part of the render.
      // Two sprites with the same cells: the normal one and a wider one for
      // the new-thread page. Even cell counts keep each sprite's half size a
      // whole number of cells, so centering it never splits a pixel.
      const sprite = glowSpriteSpan();
      const even = (n) => n + (n % 2);
      // The glow is sized from the message box, not the pane: its shape around
      // the box is then the same in every window (a pane-sized glow came out
      // flat and low behind the box in a short window).
      const boxW = composerWidth > 0 ? composerWidth : rect.width / GLOW_BOX.paneW;
      // With the sidebar open the box sits near the pane's left edge, and a
      // full-size glow ran under the sidebar on that side only, so it looked
      // shifted right. It narrows to the room on the nearer side instead (its
      // height gives way a third as much, keeping the dome), so it always ends
      // the same distance past both sides of the box.
      const room = Math.min(cx, 1 - cx) * rect.width;
      const fit = Math.max(0.6, Math.min(1, room / (GLOW_BOX.rx * GLOW_BOX.reach * boxW)));
      const fitY = 1 - (1 - fit) / 3;
      const { cell, cols, rows } = ditherGrid(2 * GLOW_BOX.rx * boxW * fit, 2 * GLOW_BOX.ry * boxW * fitY, dpr, cellCss);
      const near = { cols: even(cols), rows: even(rows) };
      const wideCols = even(Math.round(near.cols * HERO_SPREAD));
      const wideRows = even(Math.round(near.rows * HERO_SPREAD));
      job = { mode, style, cell, ...near, wideCols, wideRows, sprite };
      // Place and size the sprites now. A size change shows the previous image
      // stretched to the new size for the few milliseconds until the new one is drawn.
      const snap = (v) => `${(Math.round(v * dpr) / dpr).toFixed(2)}px`;
      const x = snap(cx * rect.width);
      const y = snap(cy == null ? rect.height + GLOW_BOX.drop * boxW * fitY : cy * rect.height);
      setStyle(pos, "transform", `translate(${x}, ${y})`);
      setStyle(nearEl, "width", px(near.cols * cell));
      setStyle(nearEl, "height", px(near.rows * cell));
      setStyle(wideEl, "width", px(wideCols * cell));
      setStyle(wideEl, "height", px(wideRows * cell));
      if (layer.hasAttribute("data-wide") !== wide) layer.toggleAttribute("data-wide", wide);
    } else {
      const { cell, cols, rows } = ditherGrid(rect.width, rect.height, dpr, cellCss);
      job = { mode, style, cell, cols, rows, cx: Math.round(cx * 200) / 200 };
    }
    if (mode === "half-circle") {
      job.accent = toRgb(g.accent === "theme" ? themeColor("--primary", "#6d7cff", host) : g.accent, "#6d7cff");
      job.intensity = i;
    } else {
      if (!imageSrc) return;
      job.imageSrc = imageSrc;
      job.background = toRgb(themeColor("--background", "#0a0a0a", host), "#0a0a0a");
      Object.assign(job, { scrimTop: 1 - i * 0.55, scrimBottom: 1 - i * 0.9 });
    }
    if (!job.accent && !job.background) return;
    const key = JSON.stringify({ ...job, imageSrc: imageSrc ? `${imageSrc.length}:${imageSrc.slice(0, 64)}:${imageSrc.slice(-64)}` : null });
    if (key === lastKey) {
      // Back to what is shown (a size that only lasted a moment, mid thread
      // switch): drop the render queued for it. A remounted pane gets the
      // current images straight away (unchanged values are not rewritten).
      if (timer) win.clearTimeout(timer);
      timer = null;
      if (scheduledKey) generation += 1; // stops a render already under way
      scheduledKey = null;
      if (shown) showImages();
      return;
    }
    if (shown) showImages();
    if (key === scheduledKey) return;
    const cached = renders.get(key);
    if (cached) {
      if (timer) win.clearTimeout(timer);
      timer = null;
      if (scheduledKey) generation += 1;
      scheduledKey = null;
      shown = cached;
      remember(key, cached);
      lastKey = key;
      showImages();
      return;
    }
    scheduledKey = key;
    if (timer) win.clearTimeout(timer);
    // First paint immediately; later changes (resizes, slider drags) settle first.
    timer = win.setTimeout(() => run(job, key), lastKey ? delayMs : 0);
  }

  return { update, clear };
}
