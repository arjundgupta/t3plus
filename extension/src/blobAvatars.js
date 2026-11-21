// Blob avatars: soft, solid-color blobs with two black capsule eyes and no mouth: the
// eyes carry the mood. Vector shapes, not pixel art. Each blob is a smooth closed curve
// through points made by a small radius function (original shapes: drops, pebbles,
// squircles, lumpy blobs), turned a little for character, its eyes placed and tilted
// to match. Each mood is a short looping animation on one sprite sheet.
//
// The sheet is drawn once into a canvas and kept as a PNG when the page can (a
// rasterizer is set: setBlobRasterizer): a vector sheet of a hundred frames is laid out
// and painted again whole on every frame step, where a picture is only moved. Without
// one (tests, a page with no canvas), and where a face is drawn large, it is an SVG.

const TAU = Math.PI * 2;

/** Points around (cx, cy): r(θ) for n angles, the whole turned by `turn` degrees. */
function ring(r, { n = 28, cx = 12, cy = 12.6, turn = 0 } = {}) {
  const t = (turn * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    const rr = r(a);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    return [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)];
  });
}

/** A closed Catmull-Rom curve through the points, as cubic Béziers. */
function smoothPath(pts) {
  const n = pts.length;
  const p = (i) => pts[(i + n) % n];
  let d = `M${p(0)[0].toFixed(2)} ${p(0)[1].toFixed(2)}`;
  for (let i = 0; i < n; i += 1) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

const superellipse = (rx, ry, k) => (a) => (Math.abs(Math.cos(a) / rx) ** k + Math.abs(Math.sin(a) / ry) ** k) ** (-1 / k);
const ellipse = (rx, ry) => (a) => (rx * ry) / Math.hypot(ry * Math.cos(a), rx * Math.sin(a));
// A drop: round, pulled out to a soft tip toward angle `tip` (radians; -π/2 is up).
const drop = (r, pull, tip, width = 1.1) => (a) => {
  const d = Math.atan2(Math.sin(a - tip), Math.cos(a - tip));
  return r + pull * Math.exp(-((d / (0.62 * width)) ** 2));
};

// Each blob: its outline, and its eyes: center (x, y), spacing, and tilt (degrees).
const B = {
  drop: { r: drop(8.2, 4.6, -Math.PI / 2 + 0.55), turn: 0, eyes: [10.2, 14.2, 4.7, 0] },
  pebble: { r: ellipse(9.8, 7.8), turn: -14, eyes: [11.4, 12.6, 4.7, -14] },
  squircle: { r: superellipse(8.8, 8.4, 3.2), turn: 6, eyes: [10.8, 12.4, 4.9, 6] },
  bean: { r: (a) => 8.3 + 1.5 * Math.cos(2 * a + 0.4) - 1.1 * Math.cos(a - 1.2), turn: 0, eyes: [12.4, 12, 4.7, 10] },
  trefoil: { r: (a) => 8.4 + 1.25 * Math.cos(3 * a + 0.9), turn: 0, eyes: [11.6, 12.8, 4.7, -6] },
  cloud: { r: (a) => 8.6 + 0.85 * Math.cos(5 * a + 0.3), turn: 0, eyes: [12, 13, 4.9, 0] },
  egg: { r: (a) => 8.6 + 1.2 * Math.sin(a), turn: 8, eyes: [11.2, 13.6, 4.7, 8] },
  mochi: { r: superellipse(9.6, 7.6, 2.6), turn: 0, eyes: [12.6, 13.2, 5.1, 0] },
  wobble: { r: (a) => 8.5 + 0.9 * Math.cos(2 * a + 0.5) + 0.7 * Math.cos(3 * a + 2), turn: -6, eyes: [11.8, 12.4, 4.7, -10] },
  lean: { r: drop(8.2, 4.4, -Math.PI / 2 - 0.6), turn: 0, eyes: [13.6, 14.2, 4.7, 0] },
  tilt: { r: superellipse(8.6, 8.6, 3.6), turn: -12, eyes: [12.6, 12.4, 4.9, -12] },
  pudding: { r: (a) => 8.4 + 1.3 * Math.sin(a) ** 3 + 0.5 * Math.cos(4 * a), turn: 0, eyes: [12, 13.4, 5.1, 0] },
};

export const BLOB_NAMES = Object.freeze(Object.keys(B));
const paths = new Map(Object.entries(B).map(([k, b]) => [k, smoothPath(ring(b.r, { turn: b.turn }))]));

const INK = "#0e0e11";
const W = 2.5; // capsule width
const H = 4.9; // and height
// One eye, centered on its spot: a rounded rect [x, y, width, height, radius], or a stroked
// path. The same shapes for the SVG and the canvas.
const EYES = {
  open: { rect: [-W / 2, -H / 2, W, H, W / 2] },
  wide: { rect: [-W / 2, -H * 0.62, W, H * 1.24, W / 2] },
  lidded: { rect: [-W / 2, -H * 0.05, W, H * 0.55, W / 2] },
  closed: { rect: [-W * 0.62, 0.5, W * 1.24, 0.95, 0.47] },
  happy: { stroke: "M-1.45 0.9Q0 -1.7 1.45 0.9", width: 1.35 },
  x: { stroke: "M-1.1 -1.1L1.1 1.1M1.1 -1.1L-1.1 1.1", width: 1.2 },
};
const eyeShape = (glyph) => EYES[glyph] ?? EYES.open;
function eye(glyph) {
  const e = eyeShape(glyph);
  if (e.stroke) return `<path d="${e.stroke}" fill="none" stroke="${INK}" stroke-width="${e.width}" stroke-linecap="round"/>`;
  const [x, y, w, h, r] = e.rect;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
}

const mix = (hex, toward, t) => {
  const a = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => Number.parseInt(toward.slice(i, i + 2), 16));
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};

// Motion, like a living sticker: the eyes rest, then glide to a new spot (stretching a
// little as they go), blink now and then, and the body breathes. Each mood is a loop of
// FPS frames a second on one sprite sheet, stepped by the shared sprite clock.
//   look: [t (s), dx, dy] rest points; the eyes ease from each to the next, and from
//         the last back to the first. blinks / hops: when they start (s).
//   breathe: how far the body stretches (fraction); sway: how far it rocks (degrees).
// The body also leans a little toward where the eyes look.
const FPS = 12;
const MOODS = {
  awake: { duration: 6, eyes: "open", look: [[0, 0, 0], [1.5, 0, 0], [1.95, -1.6, -0.7], [3, -1.6, -0.7], [3.45, 1.5, 0.2], [4.7, 1.5, 0.2], [5.2, 0, 0]], blinks: [1, 4.1], breathe: 0.025 },
  idle: { duration: 7.5, eyes: "open", dim: true, look: [[0, 0, 0.5], [3, 0, 0.5], [3.7, -1.2, 0.8], [6, -1.2, 0.8], [6.7, 0, 0.5]], blinks: [2.2, 5.2], breathe: 0.018 },
  waiting: { duration: 6, eyes: "lidded", look: [[0, 1.1, 0], [2.4, 1.1, 0], [3, -1, 0], [5, -1, 0], [5.6, 1.1, 0]], blinks: [4], breathe: 0.02 },
  done: { duration: 4.8, eyes: "happy", look: [[0, 0, 0], [2.2, 0, 0], [2.6, 0.9, -0.4], [4, 0.9, -0.4], [4.4, 0, 0]], hops: [0.5], breathe: 0.03 },
  failed: { duration: 6, eyes: "x", dark: true, look: [[0, 0, 0.4]], breathe: 0.012, sway: 2 },
  working: { duration: 2, eyes: "open", look: [[0, -1.5, 0.2], [0.3, -1.5, 0.2], [0.58, 1.5, 0.2], [0.9, 1.5, 0.2], [1.15, 0, 0.5], [1.75, 0, 0.5]], blinks: [1.4], breathe: 0.035 },
  attention: { duration: 1.5, eyes: "wide", look: [[0, 0, -0.3]], hops: [0.1, 0.6], blinks: [1.1], breathe: 0.02 },
};

const ease = (u) => u * u * (3 - 2 * u);
/** Where the eyes look at time t (s) of a loop `duration` long: [dx, dy]. */
function lookAt(look, t, duration) {
  for (let i = 0; i < look.length; i += 1) {
    const [t0, x0, y0] = look[i];
    const [t1, x1, y1] = i + 1 < look.length ? look[i + 1] : [duration + look[0][0], look[0][1], look[0][2]];
    if (t >= t0 && t < t1) {
      const u = ease((t - t0) / (t1 - t0));
      return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u];
    }
  }
  return [look[0][1], look[0][2]];
}
/** 0 → 1 → 0 over `len` seconds from each start time (wrapping the loop), else 0. */
function bump(starts, t, len, duration) {
  let v = 0;
  for (const s of starts ?? []) {
    const d = (((t - s) % duration) + duration) % duration;
    if (d < len) v = Math.max(v, Math.sin((Math.PI * d) / len));
  }
  return v;
}

/** One mood's frames: eye offset and scale, body stretch, hop and rock. */
function moodFrames(m) {
  const count = Math.round(m.duration * FPS);
  const step = m.duration / count;
  const breaths = Math.max(1, Math.round(m.duration / 2.6)); // a breath every ~2.6 s, whole ones per loop
  return Array.from({ length: count }, (_, i) => {
    const t = i * step;
    const [dx, dy] = lookAt(m.look, t, m.duration);
    const [nx, ny] = lookAt(m.look, (t + step) % m.duration, m.duration);
    const speed = Math.min(1, Math.hypot(nx - dx, ny - dy) / 0.9); // 1 at a quick glide
    const blink = bump(m.blinks, t, 0.26, m.duration);
    const hop = bump(m.hops, t, 0.42, m.duration);
    return {
      dx,
      dy,
      sx: 1 + 0.28 * speed,
      sy: Math.max(0.12, (1 - 0.16 * speed) * (1 - 0.88 * blink)),
      lift: 1.4 * hop,
      breathe: (m.breathe ?? 0) * Math.sin((TAU * breaths * t) / m.duration),
      sway: (m.sway ?? 0) * Math.sin((TAU * t) / m.duration) + 1.6 * dx,
    };
  });
}
const FRAMES = new Map(Object.entries(MOODS).map(([k, m]) => [k, moodFrames(m)]));

// The frame a blob's loop starts on, from its color, shape and mood, so a sidebar of
// them is not all in step.
function phase(key, n) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}
const n2 = (v) => String(Math.round(v * 100) / 100);

// A face at rest: eyes centered and open (the mood's own eyes), no breath, hop or rock.
const REST = Object.freeze([Object.freeze({ dx: 0, dy: 0, sx: 1, sy: 1, lift: 0, breathe: 0, sway: 0 })]);

// Pixels per frame of a drawn sheet: a 30px face at twice the density (and the smaller
// ones, 12 to 20px), crisp. Larger faces (Settings' 48px one) take the SVG.
export const BLOB_RASTER_PX = 64;
let rasterize = null;
/**
 * How sheets are drawn into a picture: `fn(width, height, draw)` makes a canvas of that
 * size, calls draw(ctx) on its 2D context, and returns the picture as a data: URL (or
 * null when it cannot). Null (the default) keeps every sheet an SVG.
 */
export function setBlobRasterizer(fn) {
  rasterize = typeof fn === "function" ? fn : null;
}

/** Each frame's pose, in the sheet's 24x24 units: the body's stretch, hop and rock, and where the eyes are. */
function framePoses(list, start, ex, ey) {
  return list.map((_, i) => {
    const f = list[(i + start) % list.length];
    // Breathing stretches the blob from its foot (y 21.5); a hop lifts it, squashed a touch.
    const sy = 1 + f.breathe - 0.04 * f.lift;
    const sx = 1 - f.breathe * 0.6 + 0.03 * f.lift;
    return { sx, sy, tx: 12 * (1 - sx), ty: 21.5 * (1 - sy) - f.lift, sway: f.sway, ox: ex + f.dx, oy: ey + f.dy, esx: f.sx, esy: f.sy };
  });
}

function svgSheet(name, body, glyph, poses, gap, tilt) {
  // The body and one eye are drawn once; every frame reuses them.
  const defs = `<defs><path id="b" fill="${body}" d="${paths.get(name)}"/><g id="e" fill="${INK}">${eye(glyph)}</g></defs>`;
  const frames = poses.map((p, i) => {
    const rock = p.sway ? `rotate(${n2(p.sway)} 12 21.5)` : "";
    const pose = `translate(${n2(p.tx)} ${n2(p.ty)})scale(${n2(p.sx)} ${n2(p.sy)})${rock}`;
    const one = (d) => `<use href="#e" transform="translate(${n2(p.ox + d)} ${n2(p.oy)})scale(${n2(p.esx)} ${n2(p.esy)})"/>`;
    return `<g transform="translate(${i * 24} 0)${pose}"><use href="#b"/><g transform="rotate(${tilt} ${n2(p.ox)} ${n2(p.oy)})">${one(-gap / 2)}${one(gap / 2)}</g></g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${24 * frames.length} 24">${defs}${frames.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const bodyPaths = new Map(); // shape -> Path2D, made on first use (only where there is a canvas)
const RAD = Math.PI / 180;
/** The same frames as svgSheet, drawn on a canvas: a data: URL, or null. */
function rasterSheet(name, body, glyph, poses, gap, tilt) {
  const px = BLOB_RASTER_PX;
  const shape = eyeShape(glyph);
  const url = rasterize(px * poses.length, px, (ctx) => {
    const Path = ctx.canvas?.ownerDocument?.defaultView?.Path2D ?? globalThis.Path2D;
    if (!bodyPaths.has(name)) bodyPaths.set(name, new Path(paths.get(name)));
    const outline = bodyPaths.get(name);
    const stroke = shape.stroke ? new Path(shape.stroke) : null;
    const k = px / 24;
    ctx.fillStyle = body;
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    poses.forEach((p, i) => {
      ctx.setTransform(k, 0, 0, k, i * px, 0);
      ctx.translate(p.tx, p.ty);
      ctx.scale(p.sx, p.sy);
      if (p.sway) {
        ctx.translate(12, 21.5);
        ctx.rotate(p.sway * RAD);
        ctx.translate(-12, -21.5);
      }
      ctx.fillStyle = body;
      ctx.fill(outline);
      // The eyes, turned about their center.
      ctx.translate(p.ox, p.oy);
      ctx.rotate(tilt * RAD);
      ctx.translate(-p.ox, -p.oy);
      ctx.fillStyle = INK;
      for (const d of [-gap / 2, gap / 2]) {
        ctx.save();
        ctx.translate(p.ox + d, p.oy);
        ctx.scale(p.esx, p.esy);
        if (stroke) {
          ctx.lineWidth = shape.width;
          ctx.stroke(stroke);
        } else {
          ctx.beginPath();
          ctx.roundRect(...shape.rect);
          ctx.fill();
        }
        ctx.restore();
      }
    });
  });
  return typeof url === "string" && url.startsWith("data:image/") ? `url("${url}")` : null;
}

/**
 * A blob's sprite sheet for `mood`, in `fill` ("#rrggbb"): { url, frames, duration }.
 * `still`: one frame at rest instead (a subagent's face under its bot). `vector`: an
 * SVG even where sheets are drawn (a face shown larger than BLOB_RASTER_PX / 2).
 */
export function blobArt(fill, shape, mood = "awake", { still = false, vector = false } = {}) {
  const name = Object.hasOwn(B, shape) ? shape : "drop";
  const key = Object.hasOwn(MOODS, mood) ? mood : "awake";
  const m = MOODS[key];
  const list = still ? REST : FRAMES.get(key);
  const [ex, ey, gap, tilt] = B[name].eyes;
  const body = m.dark ? mix(fill, "#000000", 0.28) : m.dim ? mix(fill, "#808080", 0.22) : fill;
  const poses = framePoses(list, phase(`${fill}:${name}:${key}`, list.length), ex, ey);
  const url = (!vector && rasterize && rasterSheet(name, body, m.eyes, poses, gap, tilt)) || svgSheet(name, body, m.eyes, poses, gap, tilt);
  return { url, frames: poses.length, duration: still ? 0 : m.duration };
}
