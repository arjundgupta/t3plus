import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createBackdropRenderer } from "../src/backdropRenderer.js";
import { assignBotShapes, botArt, defaultBotShape, setBotArtEncoder, setBotStyle } from "../src/botArt.js";
import { applyAvatarVars, clearAvatarVars, decorateBotBreadcrumb, resolveBotPresentation } from "../src/bots.js";
import { applyBubble } from "../src/bubbles.js";
import { BOT_SHAPES, BOT_STYLES, T3PLUS } from "../src/config.js";
import { createDitherCanvas } from "../src/ditherChart.js";
import { GLOW_SHAPE, bayerThreshold, ditherLevel, glowPixelArt, glowSpriteSpan, glowTones, grainThreshold } from "../src/ditherMath.js";
import { normalizeSettings } from "../src/settings.js";
import { createDom, virtualClock } from "./helpers.js";

// What a profile switch draws: the glow's renders, the charts' repaints, the bots' faces.

/** A page whose canvases draw (jsdom has none): toBlob held until release(), URLs counted. */
/** A page whose canvases count their work. `clock` (helpers.js virtualClock): time is moved by the test. */
function canvasPage({ clock = null } = {}) {
  const dom = createDom("/env1/a1", '<div data-workspace-area="conversation" id="pane"></div>');
  const win = dom.window;
  clock?.attach(win);
  const wait = (ms) => (clock ? clock.advance(ms) : new Promise((r) => setTimeout(r, ms)));
  const held = [];
  const counts = { blobs: 0, created: 0, revoked: 0, fills: 0, styleReads: 0 };
  // A color painted is read back as its bytes (color.js reads any CSS color that way).
  const bytes = (css) => (/^#[0-9a-f]{6}$/i.test(css) ? [1, 3, 5].map((i) => Number.parseInt(css.slice(i, i + 2), 16)) : [109, 124, 255]);
  win.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: "",
    clearRect() {},
    fillRect() {
      counts.fills += 1;
    },
    getImageData() {
      return { data: [...bytes(this.fillStyle), 255] };
    },
    putImageData() {},
    drawImage() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  win.HTMLCanvasElement.prototype.toBlob = (done) => {
    counts.blobs += 1;
    held.push(() => done(new win.Blob(["png"])));
  };
  win.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  win.URL.createObjectURL = () => `blob:x/${(counts.created += 1)}`;
  win.URL.revokeObjectURL = () => (counts.revoked += 1);
  const computed = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el, ...rest) => {
    counts.styleReads += 1;
    return computed(el, ...rest);
  };
  const release = async () => {
    // Each render's slices and encodes come one after another: let them all through.
    for (let i = 0; i < 40; i += 1) {
      while (held.length) held.shift()();
      await wait(2);
    }
  };
  return { dom, win, doc: win.document, counts, release, wait, pane: win.document.getElementById("pane") };
}
const glowSettings = (accent, patch = {}) => normalizeSettings({ composerGradient: { accent, ...patch } });
const PANE = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };

test("the glow of each of nine profiles is drawn once: switching round them again shows each at once", async () => {
  const t = canvasPage();
  const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 5 });
  const accents = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#123456", "#654321", "#abcdef"];
  const show = (accent) => renderer.update({ mode: "half-circle", settings: glowSettings(accent), host: t.pane, hostRect: PANE, cx: 0.5, composerWidth: 600 });
  for (const accent of accents) {
    show(accent);
    await t.release();
  }
  const drawn = t.counts.blobs;
  assert.equal(drawn, 2 * accents.length, "each drawn once (the thread's sprite and the new-thread page's)");
  const near = t.pane.querySelector(".t3plus-glow-near");
  for (const accent of accents) {
    const before = near.style.backgroundImage;
    show(accent);
    assert.notEqual(near.style.backgroundImage, before, `${accent}: shown in the same update, nothing waited for`);
  }
  await t.release();
  assert.equal(t.counts.blobs, drawn, "none drawn again");
  renderer.clear();
});

test("a glow asked for again while it is being drawn (a size that lasted a moment between) is drawn once, and no image is left unreleased", async () => {
  // On the virtual clock, so the full suite's load cannot change what is due when (on
  // real time it failed there now and then).
  const t = canvasPage({ clock: virtualClock() });
  const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 5 });
  const show = (width) => renderer.update({ mode: "half-circle", settings: glowSettings("#ff3366"), host: t.pane, hostRect: PANE, cx: 0.5, composerWidth: width });
  show(600); // A: drawing starts at once
  await t.wait(20);
  assert.equal(t.counts.blobs, 1, "A's first sprite is being encoded");
  show(480); // B, a transient width mid thread switch
  show(600); // and A again
  await t.wait(20);
  await t.release();
  assert.equal(t.counts.blobs, 2, "A drawn once (two sprites), B never");
  await t.wait(1100); // past the grace a replaced image gets
  assert.equal(t.counts.created - t.counts.revoked, 2, "only the images kept are alive");
  renderer.clear();
  assert.equal(t.counts.created, t.counts.revoked, "and clear releases them");
});

test("a new color alone (a profile switch) is drawn at once; a new size waits for the resize to settle", async () => {
  // On a clock the test moves: on the real one, a loaded machine started the render later than 20 ms.
  const t = canvasPage({ clock: virtualClock() });
  const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 300 });
  const show = (accent, width = 600) => renderer.update({ mode: "half-circle", settings: glowSettings(accent), host: t.pane, hostRect: PANE, cx: 0.5, composerWidth: width });
  show("#ff0000");
  await t.release();
  const first = t.counts.blobs;
  await t.wait(320); // the last ask long ago
  show("#00ff00");
  await t.wait(20);
  assert.equal(t.counts.blobs, first + 1, "started without the settle delay");
  await t.release();
  const second = t.counts.blobs;
  await t.wait(320);
  show("#00ff00", 520); // the composer resizing
  await t.wait(20);
  assert.equal(t.counts.blobs, second, "a size change settles first");
  await t.wait(300);
  assert.equal(t.counts.blobs, second + 1, "and is drawn once it has");
  renderer.clear();
});

test("the glow's theme colors are read once per theme: t3+'s own values on <html> and time passing are no theme change", async () => {
  const t = canvasPage();
  const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 5 });
  let now = 0;
  t.win.performance.now = () => now;
  // T3's theme, there (one not there yet is read again later: c2-crossfile-backdrop.test.js).
  t.pane.style.setProperty("--primary", "#6d7cff");
  t.pane.style.setProperty("--background", "#0a0a0a");
  const show = () => renderer.update({ mode: "half-circle", settings: glowSettings("theme"), host: t.pane, hostRect: PANE, cx: 0.5, composerWidth: 600 });
  show();
  const reads = t.counts.styleReads;
  assert.ok(reads > 0, "read for the first glow");
  t.doc.documentElement.style.setProperty("--t3plus-something", "1");
  applyBubble(t.doc, "#3b82f6");
  now += 4000;
  show();
  assert.equal(t.counts.styleReads, reads, "no new read: nothing of T3's theme changed");
  t.doc.documentElement.setAttribute("data-theme-id", "midnight");
  show();
  assert.ok(t.counts.styleReads > reads, "another palette: read again");
  renderer.clear();
});

test("a chart's check-time paint reads no layout or style, and repaints only for a real change (not t3+'s own values on <html>)", () => {
  const t = canvasPage();
  let report = null;
  t.win.ResizeObserver = class {
    constructor(callback) {
      report = (width, height) => callback([{ contentRect: { width, height } }]);
    }
    observe() {}
    disconnect() {}
  };
  const chart = createDitherCanvas(t.doc, [{ points: [[0, 0.5], [1, 0.25]], color: "#d97757" }], { cell: 2 });
  t.doc.body.append(chart.canvas);
  let layoutReads = 0;
  Object.defineProperty(chart.canvas, "clientWidth", { get: () => (layoutReads += 1, 300) });
  report(300, 72);
  const painted = t.counts.fills;
  assert.ok(painted > 0, "painted at its reported size");
  assert.ok(chart.canvas.parentElement.hasAttribute("data-t3plus-painted"), "its own attribute, not the glow's data-t3plus-dithered");
  const styleReads = t.counts.styleReads;
  applyBubble(t.doc, "#3b82f6");
  t.doc.documentElement.style.setProperty("--t3plus-something", "1");
  chart.paint({ cell: 2 });
  assert.equal(t.counts.fills, painted, "nothing changed: nothing drawn");
  assert.equal(layoutReads, 0, "its size from its observer, not a layout read");
  assert.equal(t.counts.styleReads, styleReads, "its pixel size from the settings, not <html>'s style");
  chart.paint({ cell: 3 });
  assert.ok(t.counts.fills > painted, "a new pixel size repaints");
  const again = t.counts.fills;
  t.doc.documentElement.classList.add("dark");
  chart.paint({ cell: 3 });
  assert.ok(t.counts.fills > again, "so does a theme change");
});

/** The glow as first written (Math.hypot per pixel), to hold the faster one to the same pixels. */
function referenceGlow({ width, height, cx, rgb, intensity, style, sprite, light }) {
  const out = new Uint8ClampedArray(width * height * 4);
  if (intensity <= 0) return out;
  const tones = glowTones(rgb, style, light);
  const threshold = style === "grain" ? grainThreshold : bayerThreshold;
  const strength = (u, v, cxx, cyy) => {
    const du = u - cxx;
    const dv = v - cyy;
    const d1 = Math.hypot(du / GLOW_SHAPE.coreRx, dv / GLOW_SHAPE.coreRy);
    const d2 = Math.hypot(du / GLOW_SHAPE.haloRx, dv / GLOW_SHAPE.haloRy);
    if (d2 >= 1 && d1 >= 1) return 0;
    const core = d1 < 1 ? (1 - d1) ** 1.2 : 0;
    const halo = d2 < 1 ? (1 - d2) ** 1.6 * 0.7 : 0;
    return Math.min(1, (1 - (1 - core) * (1 - halo)) * (0.6 + 0.8 * intensity));
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const m = sprite
        ? strength(0.5 + ((x + 0.5) / width - 0.5) * sprite.spanX, 0.5 + ((y + 0.5) / height - 0.5) * sprite.spanY, 0.5, 0.5)
        : strength((x + 0.5) / width, (y + 0.5) / height, cx, 1 + GLOW_SHAPE.drop);
      if (m <= 0) continue;
      const level = ditherLevel(Math.min(m, 0.9), tones.length, threshold(x, y));
      if (!level) continue;
      const [color, a] = tones[level];
      out.set([...color, Math.round(255 * a * (0.6 + 0.4 * intensity))], (y * width + x) * 4);
    }
  }
  return out;
}

test("the glow's pixels are the same as the first way of working them out, in every style, light or dark, sliced or whole", () => {
  const sprite = glowSpriteSpan();
  let cases = 0;
  for (const [width, height] of [[548, 360], [101, 67], [37, 23], [2, 2]]) {
    for (const style of ["bayer", "grain", "spectrum"]) {
      for (const light of [false, true]) {
        for (const intensity of [0, 0.1, 0.45, 1]) {
          for (const sp of [sprite, null]) {
            const o = { width, height, cx: 0.37, rgb: [109, 124, 255], intensity, style, sprite: sp, light };
            const expected = referenceGlow(o);
            assert.deepEqual(glowPixelArt(o), expected, `${width}x${height} ${style} ${light ? "light" : "dark"} ${intensity} ${sp ? "sprite" : "pane"}`);
            const sliced = new Uint8ClampedArray(width * height * 4);
            for (let row = 0; row < height; row += 4) glowPixelArt({ ...o, out: sliced, fromRow: row, toRow: row + 4 });
            assert.deepEqual(sliced, expected);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 192);
});

test("bot faces come out exactly as before the faster drawing: every pixel shape and mood, as SVG and as the PNG encoder's pixels", () => {
  const blobs = new Set(BOT_STYLES.blobs.shapes);
  // Classic's teardrop came back after these were recorded (Blobs had taken its name).
  const shapes = Object.keys(BOT_SHAPES).filter((shape) => !blobs.has(shape) && shape !== "teardrop");
  const moods = ["awake", "idle", "waiting", "done", "failed", "working", "attention"];
  const hash = createHash("sha256");
  try {
    setBotArtEncoder(null);
    for (const shape of shapes) for (const mood of moods) for (const color of ["blue", "#14b8a6"]) hash.update(`${shape}|${mood}|${color}|${botArt(color, shape, mood).url}\n`);
    setBotArtEncoder((pixels, width, height, fills) => {
      hash.update(`${width}x${height}|${fills.join(",")}|`);
      hash.update(pixels);
      return "data:x";
    });
    for (const shape of shapes) for (const mood of moods) for (const color of ["blue", "#14b8a6"]) botArt(color, shape, mood);
  } finally {
    setBotArtEncoder(null);
  }
  assert.equal(shapes.length, 36);
  assert.equal(hash.digest("hex"), "9164529bcb2658e0586496a924a86fbec75edf53b000f0a7376a212435aeb103");
});

test("each bot style keeps its own deal: a profile with another style and back leaves every face as it was", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `env1:z${i}`);
  try {
    setBotStyle("classic");
    assignBotShapes(keys.slice(0, 6));
    assignBotShapes(keys); // a second wave (a folder opened)
    const dealt = keys.map(defaultBotShape);
    setBotStyle("sports"); // another profile's look
    assignBotShapes(keys);
    assert.ok(keys.every((key) => BOT_STYLES.sports.shapes.includes(defaultBotShape(key))));
    setBotStyle("classic"); // back
    assignBotShapes(keys);
    assert.deepEqual(keys.map(defaultBotShape), dealt);
  } finally {
    setBotStyle("classic");
  }
});

test("a bot face is written only when it changes: a check with nothing new touches no style", () => {
  const doc = createDom("/", "<div></div>").window.document;
  const avatar = doc.createElement("span");
  avatar.setAttribute(T3PLUS.ownedAttr, "");
  doc.body.append(avatar);
  const view = (status) => resolveBotPresentation({ key: "env1:b", titleLabel: "Bot", status }, { color: "blue" });
  applyAvatarVars(avatar, view("idle"));
  const calls = [];
  for (const name of ["setProperty", "getPropertyValue", "removeProperty"]) {
    const real = avatar.style[name].bind(avatar.style);
    avatar.style[name] = (...args) => (calls.push(name), real(...args));
  }
  applyAvatarVars(avatar, view("idle"));
  assert.deepEqual(calls, [], "the same face: nothing read or written");
  applyAvatarVars(avatar, view("failed"));
  assert.ok(calls.includes("setProperty"), "another status: its face written");
  calls.length = 0;
  clearAvatarVars(avatar);
  applyAvatarVars(avatar, view("failed"));
  assert.ok(calls.includes("setProperty"), "cleared, then drawn again in full");
  // An element of T3's that lost the face to T3 (its style replaced) gets it back.
  doc.body.insertAdjacentHTML("beforeend", '<nav aria-label="Thread breadcrumb"><h2>Bot</h2></nav>');
  const heading = doc.querySelector("h2");
  const bot = { key: "env1:b", titleLabel: "Bot", status: "idle", thread: { title: "Bot" }, prefs: { color: "blue" } };
  decorateBotBreadcrumb(doc, bot);
  heading.removeAttribute("style");
  decorateBotBreadcrumb(doc, bot);
  assert.notEqual(heading.style.getPropertyValue("--t3plus-bot-fill"), "");
  assert.equal(heading.children.length, 0, "t3+ adds no children to T3's elements");
});

test("a page without a pane (Settings, Usage) keeps the glow's renders: back on a thread, the glow shows in the same update", async () => {
  const t = canvasPage();
  const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 5 });
  const show = (host, accent = "#ff3366") => renderer.update({ mode: "half-circle", settings: glowSettings(accent), host, hostRect: PANE, cx: 0.5, composerWidth: 600 });
  const marked = () => t.doc.documentElement.hasAttribute("data-t3plus-dithered");
  show(t.pane);
  await t.release();
  const image = t.pane.querySelector(".t3plus-glow-near").style.backgroundImage;
  const before = { ...t.counts };
  show(null);
  assert.equal(t.pane.querySelector(".t3plus-glow"), null, "the layer leaves the page");
  assert.equal(marked(), false);
  show(t.pane);
  assert.equal(t.pane.querySelector(".t3plus-glow-near").style.backgroundImage, image, "the same images at once");
  assert.equal(marked(), true, "the CSS fallback steps aside again");
  await t.release();
  assert.deepEqual([t.counts.blobs, t.counts.created, t.counts.revoked], [before.blobs, before.created, before.revoked], "nothing drawn again or released");

  // A render under way when the pane goes is dropped: nothing is shown for a page without one.
  show(t.pane, "#00ff00");
  await new Promise((r) => setTimeout(r, 20));
  show(null);
  await t.release();
  assert.equal(marked(), false);
  show(t.pane, "#00ff00");
  await t.release();
  assert.notEqual(t.pane.querySelector(".t3plus-glow-near").style.backgroundImage, image, "drawn for the pane once it is back");
  renderer.clear();
  assert.equal(t.counts.created, t.counts.revoked, "clear still releases every image");
});

test("an unchanged glow writes nothing, though the browser reads its values back without their trailing zeros", async () => {
  const t = canvasPage();
  const style = t.win.CSSStyleDeclaration.prototype;
  const { getPropertyValue: read, setProperty: write } = style;
  // As Chrome serializes them: "translate(640.00px, 30.50px)" reads back as "translate(640px, 30.5px)".
  style.getPropertyValue = function (name) {
    return read.call(this, name).replace(/(\.\d*?[1-9])0+px/g, "$1px").replace(/\.0+px/g, "px");
  };
  // An equal value set again changes nothing a MutationObserver sees: it is parsed all the same.
  const sets = [];
  style.setProperty = function (name, ...rest) {
    sets.push(name);
    return write.call(this, name, ...rest);
  };
  try {
    const renderer = createBackdropRenderer({ win: t.win, doc: t.doc, delayMs: 5 });
    const show = () => renderer.update({ mode: "half-circle", settings: glowSettings("#3366ff"), host: t.pane, hostRect: PANE, cx: 0.4, composerWidth: 600 });
    show();
    await t.release();
    assert.ok(sets.includes("transform"), "placed");
    sets.length = 0;
    const records = [];
    const observer = new t.win.MutationObserver((list) => records.push(...list));
    observer.observe(t.doc.documentElement, { subtree: true, attributes: true, childList: true });
    show();
    show();
    await new Promise((r) => setTimeout(r, 0));
    observer.disconnect();
    assert.deepEqual(sets, [], "no style set again");
    assert.deepEqual(records.map((r) => `${r.target.className}:${r.attributeName}`), [], "no attribute set again");
    renderer.clear();
  } finally {
    Object.assign(style, { getPropertyValue: read, setProperty: write });
  }
});
