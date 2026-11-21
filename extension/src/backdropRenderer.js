import { cssColorBytes, themeStamp } from "./color.js";
import { DITHER_STYLES, ditherRgbInPlace, glowRenderer, glowSpriteSpan } from "./ditherMath.js";

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

/**
 * `keep`: how many renders are kept to show again at once. Each profile can have its own
 * glow, in a thread with or without the details card (two sizes): kept fewer than that,
 * switching round the profiles drew every glow anew (about 165 ms before it showed). A
 * render is about 90 KB of PNG. `colorBytes` and `createCanvas`: where colors are turned
 * into bytes and the renders drawn (color.js and a canvas; stand-ins in tests).
 */
export function createBackdropRenderer({ win, doc, delayMs = 120, marksPage = true, keep = 18, colorBytes = cssColorBytes, createCanvas = () => doc.createElement("canvas") }) {
  const root = doc.documentElement;
  // The page's renderer marks <html> while its render shows (the CSS fallback steps
  // aside); a second one (a preview in Settings) leaves that mark to it.
  const markPage = (mode) => {
    if (!marksPage) return;
    if (mode) {
      if (root.getAttribute("data-t3plus-dithered") !== mode) root.setAttribute("data-t3plus-dithered", mode);
    } else root.removeAttribute("data-t3plus-dithered");
  };
  let lastKey = null;
  let scheduledKey = null;
  // A render that failed (an image that will not decode): its key stays on the CSS
  // fallback. Without this the next update brought the previous render back.
  let failedKey = null;
  let timer = null;
  let generation = 0;
  // Image mode: the pane's current size. The image shown is stretched to it until the
  // render for that size lands (left at its own size, a growing pane showed a bare strip).
  let imageBox = null;
  let shown = null; // { url, wideUrl, mode, w, h, wideW, wideH } of the last render
  const imageCache = new Map(); // src -> Promise<HTMLImageElement>

  // ---- Colors: resolve any CSS color (oklch, var(), color-mix) to sRGB bytes (color.js) ----
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
    return colorBytes(doc, cssColor, fallback)?.slice(0, 3) ?? null;
  }
  // A theme color (T3's --primary or --background) is read from the computed
  // custom property, which already has any var() resolved; the canvas then
  // turns oklch(), color-mix() or hex into bytes. No probe element: adding one
  // to the pane was a DOM change of its own. Read once per theme: T3 switches palettes
  // with data-theme-id (and its --app-theme-* inline values), light and dark with .dark,
  // and its system theme follows the OS (color.js themeStamp). t3+'s own values on <html>
  // are no theme change: counted as one, a profile switch read both colors again.
  const darkScheme = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const theme = () => `${themeStamp(root)}|${darkScheme?.matches ?? ""}`;
  const colorCache = new Map(); // name -> { stamp, value, until }
  const UNSET_COLOR_RETRY_MS = 3000;
  /** `stamp`: the theme now (theme()), worked out once for the colors one update reads. */
  function themeColor(name, fallback, el, stamp) {
    const hit = colorCache.get(name);
    if (hit?.stamp === stamp && (hit.until === Infinity || nowMs() < hit.until)) return hit.value;
    const read = win.getComputedStyle(el ?? root).getPropertyValue(name).trim();
    // Not there yet (T3's styles still loading): the fallback is drawn, and read again a
    // little later. Kept for the whole theme, the glow stayed in it until the theme changed.
    colorCache.set(name, { stamp, value: read || fallback, until: read ? Infinity : nowMs() + UNSET_COLOR_RETRY_MS });
    return read || fallback;
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
  // What was last written on each of the layer's elements, by property: an unchanged value
  // is not set again. Read back from the style instead, a value comes as the browser
  // serializes it ("640px" for "640.00px"), never matched, and every update set them all.
  const written = new WeakMap(); // element -> Map(property -> value)
  const setStyle = (el, name, value) => {
    let values = written.get(el);
    if (!values) written.set(el, (values = new Map()));
    if (values.get(name) === value) return;
    values.set(name, value);
    el.style.setProperty(name, value);
  };
  const removeStyle = (el, name) => {
    written.get(el)?.delete(name);
    el.style.removeProperty(name);
  };
  const px = (v) => `${v.toFixed(3)}px`;
  function showImages() {
    if (!layer || !shown) return;
    if (layer.hidden) layer.hidden = false;
    if (layer.getAttribute("data-kind") !== shown.mode) layer.setAttribute("data-kind", shown.mode);
    if (shown.mode === "half-circle") {
      setStyle(nearEl, "background-image", `url("${shown.url}")`);
      setStyle(wideEl, "background-image", shown.wideUrl ? `url("${shown.wideUrl}")` : "none");
      setStyle(layer, "background-image", "none");
    } else {
      setStyle(layer, "background-image", `url("${shown.url}")`);
      const box = imageBox ?? shown;
      setStyle(layer, "background-size", `${px(box.w)} ${px(box.h)}`);
    }
    markPage(shown.mode);
  }

  /**
   * No pane on this page (a Settings page without the preview, Usage): the layer leaves the
   * page, and nothing is drawn for a pane that is gone. The renders, the one shown and the
   * decoded image are kept, so coming back shows the glow at once (cleared, the CSS fallback
   * showed until it was all drawn, and an upload read and decoded, again).
   */
  function detach() {
    if (timer) win.clearTimeout(timer);
    timer = null;
    if (scheduledKey) generation += 1; // stops a render under way
    scheduledKey = null;
    markPage(null);
    layer?.remove();
  }

  function clear() {
    failedKey = null; // turned off and on again: try that render anew
    generation += 1;
    if (timer) win.clearTimeout(timer);
    timer = null;
    lastKey = null;
    scheduledKey = null;
    markPage(null);
    layer?.remove();
    layer = pos = nearEl = wideEl = null;
    if (shown && ![...renders.values()].includes(shown)) for (const u of [shown.url, shown.wideUrl]) if (u) win.URL.revokeObjectURL(u);
    forgetRenders();
    shown = null;
    imageBox = null;
    // The decoded upload (up to a few MB) is not kept once nothing is drawn from it.
    imageCache.clear();
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
  /** `live()` turning false between slices stops the render (it resolves false then). */
  async function inSlices(rows, live, fill) {
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
        if (!live()) return false;
      }
    }
    return true;
  }

  async function glowBlob(job, cols, rows, live) {
    const canvas = createCanvas();
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    const pixels = new Uint8ClampedArray(cols * rows * 4);
    const fill = glowRenderer({ width: cols, height: rows, rgb: job.accent, intensity: job.intensity, style: job.style, sprite: job.sprite, out: pixels, light: job.light });
    if (!(await inSlices(rows, live, fill))) return null;
    ctx.putImageData(new win.ImageData(pixels, cols, rows), 0, 0);
    // No blob is a failed render (out of memory, a canvas too large), not a cancelled
    // one: taken for cancelled, every later check drew it again.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the glow could not be encoded");
    return blob;
  }

  /** `live()`: whether the render is still wanted (false stops it, and it resolves null). */
  async function render(job, live) {
    if (job.mode === "half-circle") {
      // Both sprites, so switching pages never waits on a render.
      const near = await glowBlob(job, job.cols, job.rows, live);
      if (!near || !live()) return null;
      const wide = await glowBlob(job, job.wideCols, job.wideRows, live);
      return near && wide ? { near, wide } : null;
    }
    const canvas = createCanvas();
    canvas.width = job.cols;
    canvas.height = job.rows;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d canvas");
    const img = await loadImage(job.imageSrc);
    if (!live()) return null;
    drawCoverWithScrim(ctx, img, job.cols, job.rows, job);
    const data = ctx.getImageData(0, 0, job.cols, job.rows);
    if (!(await inSlices(job.rows, live, (fromRow, toRow) => ditherRgbInPlace(data.data, job.cols, job.rows, 5, job.style, fromRow, toRow)))) return null;
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the image could not be encoded");
    return { near: blob };
  }

  // The last renders, by key: a profile switched back to, or a panel toggled back and
  // forth, shows the earlier images again instead of drawing them anew.
  const renders = new Map(); // key -> shown
  // Let any paint that still uses a render's images finish first.
  const release = (r) => win.setTimeout(() => [r.url, r.wideUrl].forEach((u) => u && win.URL.revokeObjectURL(u)), 1000);
  /** A render's images as `shown` and `renders` hold them. */
  const images = (job, blobs) => ({
    mode: job.mode,
    url: win.URL.createObjectURL(blobs.near),
    wideUrl: blobs.wide ? win.URL.createObjectURL(blobs.wide) : null,
    w: job.cols * job.cell,
    h: job.rows * job.cell,
  });
  function remember(key, result) {
    const before = renders.get(key);
    renders.delete(key);
    renders.set(key, result);
    warmed.delete(key); // shown now: kept like any render shown
    if (before && before !== result && before !== shown) release(before);
    trim();
  }
  /** Back to `keep` renders: the ones used longest ago go. */
  function trim() {
    while (renders.size > keep) {
      const [oldKey, old] = renders.entries().next().value;
      renders.delete(oldKey);
      warmed.delete(oldKey);
      if (old !== shown) release(old);
    }
  }
  function forgetRenders() {
    for (const r of renders.values()) for (const u of [r.url, r.wideUrl]) if (u) win.URL.revokeObjectURL(u);
    renders.clear();
    warmed.clear();
  }

  // The render under way: asked for again meanwhile (a size that lasted a moment, then
  // back), it is the one waited for, not a second one (whose first was never released).
  let running = null; // { key, gen }
  function run(job, key) {
    timer = null;
    const gen = (generation += 1);
    running = { key, gen };
    render(job, () => gen === generation)
      .then((blobs) => {
        if (!blobs || gen !== generation) return;
        shown = images(job, blobs);
        remember(key, shown);
        showImages();
        lastKey = key;
      })
      .catch(() => {
        if (gen !== generation) return;
        // Fall back to the CSS gradient rather than leave a stale image: the layer's
        // images go too (put back by a later update, it showed the last render over
        // the fallback until the next one landed), and it stays hidden until one does.
        markPage(null);
        for (const el of [layer, nearEl, wideEl]) if (el) removeStyle(el, "background-image");
        if (layer) layer.hidden = true;
        layer?.remove();
        lastKey = key;
        failedKey = key;
        // The image it was replacing is not shown again by a later update (a resize
        // would have brought the old image back over the fallback). It stays in
        // `renders`, so going back to it is still instant (one no longer kept there is
        // released here, as clear() does).
        if (shown && ![...renders.values()].includes(shown)) for (const u of [shown.url, shown.wideUrl]) if (u) win.URL.revokeObjectURL(u);
        shown = null;
      })
      .finally(() => {
        if (scheduledKey === key) scheduledKey = null;
        if (running?.gen === gen) running = null;
      });
  }

  // ---- Warming: glows drawn ahead, while the page is idle ----
  // The first switch to a profile whose glow differs from every render kept drew it as the
  // switch landed (15-30 ms of canvas work then). The app has the other profiles' glows
  // drawn here beforehand, at the pane's size now, so a switch finds its render kept.
  // Warmed renders take at most half the cache: the other half keeps the renders really
  // shown (both sizes of the profiles visited), and the one on screen, the newest of those
  // when it was shown, is never pushed out (fewer than `keep` renders can come after it).
  const warmed = new Set(); // keys in `renders` drawn ahead and not shown since
  const warmRoom = Math.floor(keep / 2);
  /**
   * Draws the glow `settings` would show at `size` into the cache, without showing it.
   * `size`: { hostRect, cx, composerWidth } as update() takes them. Only while a glow is
   * shown and no render of its own is asked for or under way; one asked for meanwhile
   * stops it (it has the page first), and so does `idle()` turning false between slices
   * (a profile switch began). Resolves "drawn", "kept" (in the cache already, or nothing
   * to draw: no glow shown, no room left, a failed render) or "busy" (not now: try again
   * later).
   */
  async function warm(settings, { hostRect, cx, composerWidth = 0 }, { idle = () => true } = {}) {
    if (timer || scheduledKey || running) return "busy";
    const host = layer?.parentElement;
    if (!host || shown?.mode !== "half-circle" || !hostRect || hostRect.width < 2 || hostRect.height < 2) return "kept";
    if (warmed.size >= warmRoom) return "kept";
    const { job, key } = plan({ mode: "half-circle", settings, host, rect: hostRect, cx, composerWidth });
    if (!key || key === failedKey || renders.has(key)) return "kept";
    const gen = generation;
    const live = () => gen === generation && idle();
    // A render that fails here is left to a real one (which shows the fallback for it).
    const blobs = await render(job, live).catch(() => null);
    if (!live()) return "busy";
    if (!blobs || renders.has(key)) return "kept";
    renders.set(key, images(job, blobs));
    warmed.add(key);
    trim();
    return "drawn";
  }

  /**
   * What `settings` draw in `host` (its box `rect`): the render's job, its key in `renders`
   * (null: nothing to draw yet) and, for the glow, how far below the pane its center sits
   * in a thread. update() and warm() both plan here, so a glow drawn ahead is kept under
   * the key a real update asks for.
   */
  function plan({ mode, settings, imageSrc = null, host, rect, cx, composerWidth }) {
    const dpr = win.devicePixelRatio || 1;
    const g = settings.composerGradient;
    const cellCss = DITHER_CELL_CSS[g.ditherSize] ?? DITHER_CELL_CSS.medium;
    const style = DITHER_STYLES.includes(g.ditherStyle) ? g.ditherStyle : DITHER_STYLES[0];
    const i = g.intensity / 100;
    let job;
    let drop = 0;
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
      drop = GLOW_BOX.drop * boxW * fitY;
    } else {
      const { cell, cols, rows } = ditherGrid(rect.width, rect.height, dpr, cellCss);
      // Spectrum colors the glow's tones; an image keeps its own, so it is Bayer there
      // (and switching between the two draws nothing new).
      job = { mode, style: style === "spectrum" ? "bayer" : style, cell, cols, rows, cx: Math.round(cx * 200) / 200 };
    }
    // A light page (T3's light theme) takes the glow's tones the other way round, and a
    // stronger scrim over an image: the dark ramp read as dirt on white, and an image under
    // the light scrim quantized to mid greys that muted text could not be read on.
    const stamp = theme();
    const page = toRgb(themeColor("--background", "#0a0a0a", host, stamp), "#0a0a0a");
    const light = Boolean(page) && 0.2126 * page[0] + 0.7152 * page[1] + 0.0722 * page[2] > 140;
    if (mode === "half-circle") {
      job.accent = toRgb(g.accent === "theme" ? themeColor("--primary", "#6d7cff", host, stamp) : g.accent, "#6d7cff");
      job.intensity = i;
      job.light = light;
    } else {
      if (!imageSrc) return { job, key: null, drop };
      job.imageSrc = imageSrc;
      job.background = page;
      Object.assign(job, light ? { scrimTop: 1 - i * 0.3, scrimBottom: 1 - i * 0.5 } : { scrimTop: 1 - i * 0.55, scrimBottom: 1 - i * 0.9 });
    }
    if (!job.accent && !job.background) return { job, key: null, drop };
    // An image keys by a digest of its source (a data URL can be megabytes); the glow by
    // its job alone, as the image it is not drawing changes nothing in it.
    const key = JSON.stringify(mode === "image" ? { ...job, imageSrc: `${imageSrc.length}:${imageSrc.slice(0, 64)}:${imageSrc.slice(-64)}` } : job);
    return { job, key, drop };
  }

  /**
   * Places and sizes the glow's sprites now, its center at `y` down the pane. A size change
   * shows the previous image stretched to the new size for the few milliseconds until the
   * new one is drawn.
   */
  function placeSprites(job, rect, cx, y, wide) {
    const dpr = win.devicePixelRatio || 1;
    const snap = (v) => `${(Math.round(v * dpr) / dpr).toFixed(2)}px`;
    setStyle(pos, "transform", `translate(${snap(cx * rect.width)}, ${snap(y)})`);
    setStyle(nearEl, "width", px(job.cols * job.cell));
    setStyle(nearEl, "height", px(job.rows * job.cell));
    setStyle(wideEl, "width", px(job.wideCols * job.cell));
    setStyle(wideEl, "height", px(job.wideRows * job.cell));
    if (layer.hasAttribute("data-wide") !== wide) layer.toggleAttribute("data-wide", wide);
  }

  // When the last render was asked for, and its size: a change of color, strength or style
  // alone (a profile switch, a click) is drawn at once; one of a new size, or one coming
  // right after the last (a slider being dragged), settles first.
  let askedAt = -Infinity;
  let askedSize = "";
  /**
   * @param {{ mode: "half-circle" | "image" | null, settings, imageSrc: string | null,
   *           host: Element | null, hostRect?: DOMRect | null, cx: number, cy?: number | null,
   *           wide?: boolean, composerWidth?: number }} o  hostRect: the host's box as just
   *   measured (else read here); cx is 0..1 (composer center across the host); cy, when
   *   set, centers the glow vertically there (new-thread page); composerWidth is the
   *   message box's width in CSS px.
   */
  function update({ mode, settings, imageSrc, host, hostRect = null, cx, cy = null, wide = false, composerWidth = 0 }) {
    if (!mode) {
      if (lastKey || scheduledKey || layer) clear();
      return;
    }
    if (!host || typeof host.getBoundingClientRect !== "function") {
      detach();
      return;
    }
    const rect = hostRect ?? host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return; // not laid out: keep what is shown
    ensureLayer(host);
    const { job, key, drop } = plan({ mode, settings, imageSrc, host, rect, cx, composerWidth });
    if (mode === "half-circle") placeSprites(job, rect, cx, cy == null ? rect.height + drop : cy * rect.height, wide);
    else imageBox = { w: job.cols * job.cell, h: job.rows * job.cell };
    if (!key) return;
    if (key === failedKey) {
      // Hidden, not removed: ensureLayer above put it back, and removing it again
      // would be a DOM change on every check.
      markPage(null);
      if (layer && !layer.hidden) layer.hidden = true;
      return;
    }
    failedKey = null;
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
    if (timer) win.clearTimeout(timer);
    timer = null;
    scheduledKey = key;
    if (key === running?.key && running.gen === generation) return; // already being drawn
    const size = `${job.mode}|${job.cell}|${job.cols}|${job.rows}`;
    const at = nowMs();
    // The first glow at once; later changes of size (resizes) and quick runs (drags) settle first.
    const settle = Boolean(lastKey) && (size !== askedSize || at - askedAt < delayMs);
    askedAt = at;
    askedSize = size;
    timer = win.setTimeout(() => run(job, key), settle ? delayMs : 0);
  }

  return { update, warm, clear };
}
