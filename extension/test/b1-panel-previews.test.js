import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { botStill } from "../src/botArt.js";
import { BOT_SHAPES, BOT_STYLES, DEFAULT_SETTINGS } from "../src/config.js";
import { ditherSwatchMask } from "../src/settingsPreviews.js";
import { spriteCount } from "../src/spriteClock.js";
import { BOT_STATUS_COLORS } from "../src/statusView.js";
import { createDom } from "./helpers.js";

// Settings → t3+'s small previews (settingsPreviews.js), on the panel alone: the Look and
// Pixel size swatches, Bot style's faces, and the Status colors, Status badges and
// Subagents samples.
function setup() {
  const dom = createDom("/settings/appearance", "");
  const doc = dom.window.document;
  const panel = createAppearancePanel(doc, new Proxy({}, { get: () => () => {} }));
  doc.body.append(panel.element);
  const show = ({ gradient = {}, sidebar = {} } = {}) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.composerGradient, gradient);
    Object.assign(settings.sidebar, sidebar);
    panel.update({ settings, image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [] });
  };
  const row = (title) => [...doc.querySelectorAll(".t3plus-row")].find((r) => r.querySelector(".t3plus-row-title").textContent === title);
  const segments = (label) => [...doc.querySelector(`[role=radiogroup][aria-label="${label}"]`).querySelectorAll(".t3plus-segment")];
  const swatch = (label, value) => segments(label).find((s) => s.querySelector("input").value === value).querySelector(".t3plus-glow-swatch");
  const mask = (el) => el.style.getPropertyValue("--t3plus-swatch-mask");
  const fill = (el) => el.style.getPropertyValue("--t3plus-bot-fill");
  return { doc, panel, show, row, segments, swatch, mask, fill };
}
const LOOKS = ["bayer", "grain", "spectrum"];

test("a swatch's mask is the glow dithered at the pixel size, in a whole number of cells", () => {
  const cells = (look, size) => decodeURIComponent(ditherSwatchMask(look, size)).match(/viewBox="0 0 (\d+) (\d+)"/).slice(1).map(Number);
  assert.deepEqual(cells("bayer", "fine"), [18, 9]);
  assert.deepEqual(cells("bayer", "medium"), [12, 6]);
  assert.deepEqual(cells("bayer", "large"), [8, 4]);
  assert.notEqual(ditherSwatchMask("grain", "medium"), ditherSwatchMask("bayer", "medium"), "grain scatters what Bayer crosshatches");
  assert.equal(ditherSwatchMask("spectrum", "medium"), ditherSwatchMask("bayer", "medium"), "spectrum's pixels are Bayer's (its hues differ: content.css)");
  assert.match(decodeURIComponent(ditherSwatchMask("bayer", "large")), /<rect /, "even the coarsest shows dots");
});

test("Look: each choice shows its own swatch, at the pixel size set and in the glow color; both follow a change", () => {
  const p = setup();
  p.show();
  for (const look of [...LOOKS, "smooth"]) {
    const el = p.swatch("Look", look);
    assert.ok(el, look);
    assert.equal(el.getAttribute("aria-hidden"), "true", "decorative: the label says it");
    assert.equal(el.dataset.look, look);
  }
  const size = DEFAULT_SETTINGS.composerGradient.ditherSize;
  for (const look of LOOKS) assert.equal(p.mask(p.swatch("Look", look)), ditherSwatchMask(look, size), look);
  assert.equal(p.mask(p.swatch("Look", "smooth")), "", "Smooth has no pixels: a gradient");
  assert.equal(p.swatch("Look", "bayer").style.getPropertyValue("--t3plus-swatch-glow"), "var(--t3plus-hue, #6d7cff)", "Theme: T3's own color (t3+'s theme hue)");

  p.show({ gradient: { ditherSize: "large", accent: "#22d3ee" } });
  for (const look of LOOKS) assert.equal(p.mask(p.swatch("Look", look)), ditherSwatchMask(look, "large"), `${look}, large`);
  assert.equal(p.swatch("Look", "grain").style.getPropertyValue("--t3plus-swatch-glow"), "#22d3ee");
});

test("Pixel size: each size shows the look set, at that size; a new look redraws them", () => {
  const p = setup();
  p.show({ gradient: { dither: true, ditherStyle: "bayer" } });
  for (const size of ["fine", "medium", "large"]) {
    const el = p.swatch("Dither pixel size", size);
    assert.equal(el.getAttribute("aria-hidden"), "true");
    assert.equal(el.dataset.look, "bayer");
    assert.equal(p.mask(el), ditherSwatchMask("bayer", size), size);
  }
  p.show({ gradient: { dither: true, ditherStyle: "grain" } });
  for (const size of ["fine", "medium", "large"]) assert.equal(p.mask(p.swatch("Dither pixel size", size)), ditherSwatchMask("grain", size), size);
  assert.equal(p.swatch("Dither pixel size", "fine").dataset.look, "grain");
});

test("Bot style: a face of each style on its choice, drawn on the first update, not when the panel is made", () => {
  const p = setup();
  const faces = () => p.segments("Bot style").map((s) => s.querySelector(".t3plus-segment-face"));
  assert.ok(faces().every((f) => f && p.fill(f) === ""), "nothing drawn for a Settings page not shown");
  p.show();
  for (const [i, [value, style]] of Object.entries(BOT_STYLES).entries()) {
    const face = faces()[i];
    const shape = style.shapes?.[0] ?? "circle";
    assert.equal(face.getAttribute("aria-hidden"), "true");
    assert.equal(p.fill(face), botStill("purple", shape).url, value);
    assert.equal(face.style.getPropertyValue("--t3plus-bot-clip"), BOT_SHAPES[shape], value);
  }
  const blob = p.fill(faces().at(-1));
  p.show({ sidebar: { botStyle: "blobs" } });
  assert.equal(p.fill(faces().at(-1)), blob, "picking a style changes which is checked, not the faces");
  assert.equal(p.segments("Bot style").at(-1).querySelector("input").checked, true);
});

test("Status colors: the Status view's groups as faces, in their status's color only while it is on", () => {
  const p = setup();
  p.show();
  const sample = p.row("Status colors").querySelector(".t3plus-status-sample");
  assert.equal(sample.getAttribute("aria-hidden"), "true");
  assert.deepEqual([...sample.children].map((item) => item.textContent), ["Needs you", "Working", "Done", "Idle"]);
  const fills = () => [...sample.querySelectorAll(".t3plus-bot-swatch")].map(p.fill);
  const moods = ["attention", "working", "done", "idle"];
  assert.deepEqual(fills(), moods.map((m) => botStill("purple", "circle", m).url), "off: every bot in its own color");
  p.show({ sidebar: { statusColors: true } });
  assert.deepEqual(fills(), moods.map((m) => botStill(BOT_STATUS_COLORS[m], "circle", m).url), "on: orange, amber, green, blue");
  p.show();
  assert.deepEqual(fills(), moods.map((m) => botStill("purple", "circle", m).url), "and back");
});

test("Status badges: a face beside the switch, with its tile only while it is on", () => {
  const p = setup();
  p.show();
  const face = p.row("Status badges").querySelector(".t3plus-badge-sample");
  assert.equal(face.getAttribute("aria-hidden"), "true");
  assert.ok(face.querySelector(".t3plus-bot-face"), "the face");
  assert.equal(face.querySelector(".t3plus-bot-badge"), null, "off: no tile");
  p.show({ sidebar: { statusBadges: true } });
  assert.ok(face.querySelector(".t3plus-bot-badge"), "on: the tile");
  assert.ok(face.style.getPropertyValue("--t3plus-bot-badge").startsWith("url("));
  p.show();
  assert.equal(face.querySelector(".t3plus-bot-badge"), null, "off again");
});

test("Subagents: a bot and three subagents (running, finished, failed) in the shape and color picked", () => {
  const p = setup();
  p.show();
  const sample = p.row("Subagents").querySelector(".t3plus-subagent-sample");
  assert.equal(sample.getAttribute("aria-hidden"), "true");
  const minis = () => [...sample.querySelectorAll(".t3plus-bot-sub")];
  assert.equal(minis().length, 3);
  assert.deepEqual(minis().map((m) => m.hasAttribute("data-done")), [false, true, true], "the ended ones dimmed");
  assert.deepEqual(minis().map(p.fill), ["awake", "done", "failed"].map((m) => botStill("purple", "circle", m).url), "the bot's own shape and color");
  p.show({ sidebar: { subagentShape: "robot", subagentColor: "green" } });
  assert.ok(minis().every((m) => m.style.getPropertyValue("--t3plus-bot-clip") === BOT_SHAPES.robot), "the shape picked");
  assert.deepEqual(minis().map(p.fill), ["awake", "done", "failed"].map((m) => botStill("green", "robot", m).url), "the color picked");
  assert.equal(p.fill(sample.querySelector(".t3plus-bot-swatch")), botStill("purple", "circle").url, "the bot stays itself");
});

test("the previews stand still: none is stepped by the sprite clock, and an update with nothing new writes nothing", async () => {
  const p = setup();
  p.show();
  const stepped = spriteCount(); // the live preview's working bot
  // Not Status badges: the live preview's faces wear its tiles (and the working one's moves).
  p.show({ sidebar: { statusColors: true, subagentShape: "robot" } });
  assert.equal(spriteCount(), stepped, "still faces: nothing for the clock");
  const changed = { gradient: { ditherSize: "large" }, sidebar: { statusColors: true, statusBadges: true, subagentShape: "robot" } };
  p.show(changed);
  assert.equal(p.doc.querySelector(".t3plus-badge-sample").getAttribute("data-badge"), "", "a still tile (Done's check)");
  const previews = [".t3plus-glow-swatch", ".t3plus-segment-face", ".t3plus-status-sample", ".t3plus-badge-sample", ".t3plus-subagent-sample"].flatMap((s) => [...p.doc.querySelectorAll(s)]);
  const writes = [];
  const observer = new p.doc.defaultView.MutationObserver((records) => writes.push(...records));
  for (const el of previews) observer.observe(el, { attributes: true, childList: true, subtree: true });
  p.show(changed);
  await Promise.resolve();
  observer.disconnect();
  assert.deepEqual(writes.map((r) => `${r.target.className} ${r.attributeName ?? r.type}`), []);
});

test("a swatch carries only the look it is painted in: Pixel size's, unpainted while the look is Smooth, name no look", () => {
  const p = setup();
  p.show({ gradient: { dither: false } });
  for (const size of ["fine", "medium", "large"]) {
    const el = p.swatch("Dither pixel size", size);
    assert.equal(el.hasAttribute("data-look"), false, `${size}: a size is no look`);
    assert.equal(p.mask(el), "");
  }
  assert.equal(p.swatch("Look", "smooth").dataset.look, "smooth");
  p.show({ gradient: { dither: true, ditherStyle: "spectrum" } });
  for (const size of ["fine", "medium", "large"]) assert.equal(p.swatch("Dither pixel size", size).dataset.look, "spectrum", size);
});
