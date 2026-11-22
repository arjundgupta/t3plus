// Ordered (Bayer) dithering shared by the bot avatars and the background.
// Pure functions over typed arrays: no DOM, so they are easy to test.

/** n x n Bayer matrix (n a power of two), values 0..n*n-1. */
export function bayerMatrix(n) {
  let m = [[0]];
  while (m.length < n) {
    const size = m.length;
    const next = Array.from({ length: size * 2 }, () => new Array(size * 2));
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + size] = v + 2;
        next[y + size][x] = v + 3;
        next[y + size][x + size] = v + 1;
      }
    }
    m = next;
  }
  return m;
}

/**
 * The 8x8 table the CSS dither tile (dither.js) and the chart fills (ditherChart.js) share,
 * indexed [row][col]: bayerMatrix(8) transposed, the phase both were drawn in.
 */
export const BAYER_8 = ((m) => Object.freeze(m.map((row, y) => Object.freeze(row.map((_, x) => m[x][y])))))(bayerMatrix(8));

const BAYER_N = 16;
const BAYER = bayerMatrix(BAYER_N);
/** Flat thresholds in (0, 1): 256 distinct levels, so ramps step smoothly. */
const THRESHOLDS = Float32Array.from(BAYER.flat(), (v) => (v + 0.5) / (BAYER_N * BAYER_N));

export function bayerThreshold(x, y) {
  return THRESHOLDS[(y & (BAYER_N - 1)) * BAYER_N + (x & (BAYER_N - 1))];
}

/** Quantizes v (0..1) to one of `levels` steps with an ordered-dither threshold. */
export function ditherLevel(v, levels, threshold) {
  const scaled = Math.max(0, Math.min(1, v)) * (levels - 1);
  const lo = Math.floor(scaled);
  return Math.min(levels - 1, scaled - lo > threshold ? lo + 1 : lo);
}

/** Glow geometry, as shares of the pane. The center sits slightly below the bottom edge. */
export const GLOW_SHAPE = Object.freeze({ coreRx: 0.288, coreRy: 0.216, haloRx: 0.45, haloRy: 0.396, drop: 0.05 });

/**
 * Glow strength (0..1) from a pixel's squared distances to the center in the core's
 * and the halo's radii (1 on each ellipse), `gain` from the intensity. Math.sqrt of the
 * squares rather than Math.hypot: the same pixels, in half the time; and outside both
 * ellipses nothing is worked out at all (a fifth of every sprite).
 */
function strength(core2, halo2, gain) {
  if (core2 >= 1 && halo2 >= 1) return 0;
  const core = core2 < 1 ? (1 - Math.sqrt(core2)) ** 1.2 : 0;
  const halo = halo2 < 1 ? (1 - Math.sqrt(halo2)) ** 1.6 * 0.7 : 0;
  // Intensity widens the dense area.
  return Math.min(1, (1 - (1 - core) * (1 - halo)) * gain);
}

/**
 * Glow strength (0..1) at pane position u, v (0..1, v = 0 at the top): a wide
 * core and halo centered at (cx, just below the bottom edge). Shared by every
 * dither style, so they all have the same shape.
 */
export function glowStrength(u, v, cx, intensity, cy = 1 + GLOW_SHAPE.drop) {
  const du = u - cx;
  const dv = v - cy;
  const a1 = du / GLOW_SHAPE.coreRx;
  const b1 = dv / GLOW_SHAPE.coreRy;
  const a2 = du / GLOW_SHAPE.haloRx;
  const b2 = dv / GLOW_SHAPE.haloRy;
  return strength(a1 * a1 + b1 * b1, a2 * a2 + b2 * b2, 0.6 + 0.8 * intensity);
}

/**
 * Interleaved gradient noise (Jimenez 2014): a cheap, deterministic,
 * blue-noise-like threshold. Same tones as Bayer, but scattered organically
 * instead of in Bayer's crosshatch grid.
 */
export function grainThreshold(x, y) {
  const f = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return f - Math.floor(f);
}

/** The three background styles. All are pixel art in the bot avatars' style. */
export const DITHER_STYLES = Object.freeze(["bayer", "grain", "spectrum"]);

/** The threshold a style dithers with: grain its own, bayer and spectrum Bayer's. */
export const thresholdFor = (style) => (style === "grain" ? grainThreshold : bayerThreshold);

function rgbToHsl([r, g, b]) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/**
 * Shifts hue by `deg` and sets lightness to `l` (0..1), keeping saturation (with a
 * floor so a pale color still tints). A grey stays grey: its hue is 0 (red), and with
 * the floor a white, grey or black accent made a red glow.
 */
function shade(rgb, deg, l) {
  const [h, s] = rgbToHsl(rgb);
  return hslToRgb([(h + deg + 360) % 360, s < 0.08 ? s : Math.max(s, 0.35), l]);
}

// OKLab / OKLCH (Björn Ottosson's matrices): lightness that matches how light a color
// looks, which an HSL ramp does not (an HSL blue and yellow at one "lightness" are far
// apart to the eye). sRGB bytes in, sRGB bytes out.
const toLinear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toByte = (v) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
/** [L 0..1, C, h degrees] for sRGB bytes. */
export function rgbToOklch([r, g, b]) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}
function oklchLinear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const outOfGamut = (lin) => lin.some((v) => v < -1e-4 || v > 1 + 1e-4);
/** sRGB bytes for an OKLCH color; out of the sRGB gamut, the chroma is lowered (hue and lightness kept). */
export function oklchToRgb(L, C, h) {
  let lin = oklchLinear(L, C, h);
  if (outOfGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 14; i += 1) {
      const mid = (lo + hi) / 2;
      if (outOfGamut(oklchLinear(L, mid, h))) hi = mid;
      else lo = mid;
    }
    lin = oklchLinear(L, lo, h);
  }
  return lin.map(toByte);
}

/**
 * The glow's tones, darkest first. Each tone is a [rgb, alpha] pair; index 0
 * is empty (the page shows through). Tones are far apart in lightness, which
 * is what keeps the dither pattern visible instead of averaging into a smooth
 * gradient (the same reason the bot avatars read as pixel art).
 *  - bayer / grain: one hue, deep -> accent -> hot.
 *  - spectrum: the hue drifts across the ramp (a cooler deep tone, a warmer
 *    hot tone), so the glow is a streak of colored pixels.
 */
export function glowTones(rgb, style, light = false) {
  const [, , l] = rgbToHsl(rgb);
  const base = Math.min(0.62, Math.max(0.45, l));
  if (light) {
    // A light page: colored light on paper, not ink. One ink, the accent at a mid
    // lightness (OKLab L 0.60-0.68, its hue and chroma kept), laid over the page at rising
    // alpha, so the levels land at even, pale steps (about L 0.93 / 0.87 / 0.80 / 0.73 at
    // the default intensity) and the core never darkens into a muddy oval. Spectrum
    // turns the same ink's hue across the ramp. (The dark ramp's deep tones read as grey
    // dirt on white, and a darker core as a heavy blot under the composer.)
    const [L, C, H] = rgbToOklch(rgb);
    // A colored accent keeps at least a clear chroma (the gamut lowers it where it must):
    // laid on at low alpha, a muted one (Grove's, Ocean's, Ember's) left grey dust at the
    // halo's edge. A grey accent stays grey.
    const chroma = C < 0.03 ? C : Math.max(C, 0.15);
    // Spectrum turns the hue less than on dark, and never into the brown-olive band (hues
    // about 55-115 at this lightness), where an orange or green accent's tones went ochre or
    // khaki: there it turns the other way.
    const hueAt = (turn) => {
      const h = (((H + turn) % 360) + 360) % 360;
      return turn !== 0 && h > 55 && h < 115 ? H - turn : H + turn;
    };
    // A yellow or amber accent keeps more of its lightness: held at 0.68 it read as mustard.
    const warm = H > 60 && H < 115;
    const ink = (turn = 0) => oklchToRgb(Math.min(warm ? 0.8 : 0.68, Math.max(0.6, L)), chroma, hueAt(turn));
    if (style === "spectrum") return [null, [ink(-30), 0.22], [ink(-14), 0.4], [ink(), 0.62], [ink(28), 0.85]];
    const one = ink();
    return [null, [one, 0.2], [one, 0.38], [one, 0.6], [one, 0.84]];
  }
  if (style === "spectrum") {
    return [null, [shade(rgb, -48, base * 0.34), 0.75], [shade(rgb, -22, base * 0.7), 0.9], [rgb, 1], [shade(rgb, 32, Math.min(0.86, base + 0.24)), 1]];
  }
  return [null, [shade(rgb, 0, base * 0.45), 0.7], [shade(rgb, 0, base * 0.75), 0.88], [rgb, 1], [shade(rgb, 0, Math.min(0.88, base + 0.25)), 1]];
}

/**
 * The bottom glow as pixel art: every cell is one of a few far-apart tones
 * (or empty), picked by an ordered threshold (Bayer or grain). The strength is
 * capped below 1 so even the core keeps mixing its top two tones: no flat,
 * smooth-looking fill anywhere.
 *
 * Returns fill(fromRow, toRow), which draws those rows into `out`, so a caller can
 * spread a large sprite over several short tasks: the tones, alphas and each row's
 * own terms are worked out once, not again for every few rows (or every pixel).
 * @param {{ width: number, height: number, cx: number, rgb: [number, number, number], intensity: number,
 *           style?: "bayer" | "grain" | "spectrum", out: Uint8ClampedArray }} o  cx and intensity are 0..1.
 */
export function glowRenderer({ width, height, cx, rgb, intensity, style = "bayer", cy, sprite = null, out, light = false }) {
  if (intensity <= 0) return () => {};
  const tones = glowTones(rgb, style, light);
  const threshold = thresholdFor(style);
  const scale = 0.6 + 0.4 * intensity;
  const alphas = tones.map((tone) => (tone ? Math.round(255 * tone[1] * scale) : 0));
  const gain = 0.6 + 0.8 * intensity;
  // Below 1, so even the core mixes its top two levels; on a light page a little lower,
  // or the band under the composer read as one solid strip of the top level.
  const cap = light ? 0.85 : 0.9;
  const centerX = sprite ? 0.5 : cx;
  const centerY = sprite ? 0.5 : (cy ?? 1 + GLOW_SHAPE.drop);
  const { coreRx, coreRy, haloRx, haloRy } = GLOW_SHAPE;
  return (fromRow, toRow) => {
    for (let y = fromRow; y < Math.min(height, toRow); y += 1) {
      const v = sprite ? 0.5 + ((y + 0.5) / height - 0.5) * sprite.spanY : (y + 0.5) / height;
      const dv = v - centerY;
      const b1 = dv / coreRy;
      const b2 = dv / haloRy;
      const coreY = b1 * b1;
      const haloY = b2 * b2;
      for (let x = 0; x < width; x += 1) {
        const u = sprite ? 0.5 + ((x + 0.5) / width - 0.5) * sprite.spanX : (x + 0.5) / width;
        const du = u - centerX;
        const a1 = du / coreRx;
        const a2 = du / haloRx;
        const m = strength(a1 * a1 + coreY, a2 * a2 + haloY, gain);
        if (m <= 0) continue;
        const level = ditherLevel(Math.min(m, cap), tones.length, threshold(x, y));
        if (!level) continue;
        const color = tones[level][0];
        const i = (y * width + x) * 4;
        out[i] = color[0];
        out[i + 1] = color[1];
        out[i + 2] = color[2];
        out[i + 3] = alphas[level];
      }
    }
  };
}

/** The glow as pixel art in one go (glowRenderer's rows [fromRow, toRow); a new buffer unless `out`). */
export function glowPixelArt({ width, height, out = null, fromRow = 0, toRow = height, ...o }) {
  out ??= new Uint8ClampedArray(width * height * 4);
  glowRenderer({ width, height, out, ...o })(fromRow, toRow);
  return out;
}

/**
 * The glow on its own, centered in a sprite just big enough for its halo
 * (spanX/spanY = sprite size as a share of the pane). The renderer draws it
 * once and CSS moves it, so moving the glow (new thread <-> thread, composer
 * shifts) is an animated background-position, never a re-render.
 */
export function glowSpriteSpan() {
  return { spanX: GLOW_SHAPE.haloRx * 2, spanY: GLOW_SHAPE.haloRy * 2 };
}

/** Ordered dither of RGBA pixels in place: each channel snaps to `levels` steps. */
export function ditherRgbInPlace(data, width, height, levels = 8, style = "bayer", fromRow = 0, toRow = height) {
  const threshold = thresholdFor(style);
  for (let y = fromRow; y < Math.min(height, toRow); y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = threshold(x, y);
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.round((ditherLevel(data[i + c] / 255, levels, t) / (levels - 1)) * 255);
      }
      data[i + 3] = 255;
    }
  }
  return data;
}
