import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createBackdropRenderer } from "../src/backdropRenderer.js";
import { measureBackdropAnchor } from "../src/composer.js";
import { STORAGE_KEYS } from "../src/config.js";
import { computeComposerTheme, cssEscapeUrl } from "../src/gradient.js";
import { normalizeSettings } from "../src/settings.js";
import { createApp, createDom, createFakeChromeStorage, T3_COMPOSER_HTML } from "./helpers.js";

const settings = (patch) => normalizeSettings({ composerGradient: patch });

test("half-circle mode follows the theme accent by default", () => {
  const theme = computeComposerTheme(settings({ mode: "half-circle", intensity: 50 }), "chrome-extension://x/a.svg");
  assert.equal(theme.mode, "half-circle");
  assert.equal(theme.vars["--t3plus-dither-cell"], "2px", "medium pixel size is shared by every surface");
  assert.equal(theme.vars["--t3plus-accent"], null, "unset accent means var(--primary) in CSS");
  assert.equal(theme.vars["--t3plus-core"], "35%");
  assert.equal(theme.vars["--t3plus-halo"], "23%");
  assert.equal(theme.vars["--t3plus-fade"], "9%");
});

test("pixel size follows the selected dither grid", () => {
  assert.equal(computeComposerTheme(settings({ ditherSize: "fine" }), null).vars["--t3plus-dither-cell"], `${4 / 3}px`);
  assert.equal(computeComposerTheme(settings({ ditherSize: "large" }), null).vars["--t3plus-dither-cell"], "3px");
});

test("custom accent and intensity map to CSS variables", () => {
  const theme = computeComposerTheme(settings({ accent: "#ff8800", intensity: 100 }), null);
  assert.equal(theme.vars["--t3plus-accent"], "#ff8800");
  assert.equal(theme.vars["--t3plus-core"], "70%");
  const off = computeComposerTheme(settings({ intensity: 0 }), null);
  assert.equal(off.vars["--t3plus-core"], "0%");
  assert.equal(off.vars["--t3plus-scrim-top"], "100%");
  assert.equal(off.vars["--t3plus-scrim-bottom"], "100%");
});

test("image mode exposes the image URL and a top-heavy scrim", () => {
  const theme = computeComposerTheme(settings({ mode: "image", intensity: 60 }), "blob:https://app.t3.codes/1");
  assert.equal(theme.mode, "image");
  assert.equal(theme.vars["--t3plus-image"], 'url("blob:https://app.t3.codes/1")');
  assert.equal(theme.vars["--t3plus-scrim-top"], "67%");
  assert.equal(theme.vars["--t3plus-scrim-bottom"], "46%");
});

test("image mode: the sample's light version goes with it (CSS picks it on a light page); an upload has none", () => {
  const sample = computeComposerTheme(settings({ mode: "image" }), "data:image/svg+xml;base64,AA", "data:image/svg+xml;base64,BB");
  assert.equal(sample.vars["--t3plus-image-light"], 'url("data:image/svg+xml;base64,BB")');
  const upload = computeComposerTheme(settings({ mode: "image" }), "blob:https://app.t3.codes/1", null);
  assert.equal(upload.vars["--t3plus-image-light"], null);
  assert.equal(computeComposerTheme(settings({ mode: "image" }), null, "data:x").vars["--t3plus-image-light"], null, "no image, no light version");
});

test("glass is on by default and strength maps to opacity and blur", () => {
  const theme = computeComposerTheme(normalizeSettings({}), null);
  assert.equal(theme.glass, true);
  assert.equal(theme.vars["--t3plus-glass-opacity"], "37%", "default strength 85");
  assert.equal(theme.vars["--t3plus-glass-blur"], "22px");
  const clear = computeComposerTheme(normalizeSettings({ glass: { strength: 100 } }), null);
  assert.equal(clear.vars["--t3plus-glass-opacity"], "28%", "stronger glass keeps less of the card color");
  const solid = computeComposerTheme(normalizeSettings({ glass: { enabled: false, strength: 0 } }), null);
  assert.equal(solid.glass, false);
  assert.equal(solid.vars["--t3plus-glass-opacity"], "88%");
});

test("image mode without an image paints nothing", () => {
  assert.equal(computeComposerTheme(settings({ mode: "image" }), null).mode, null);
});

test("disabled gradient clears the mode", () => {
  assert.equal(computeComposerTheme(settings({ enabled: false }), "x").mode, null);
});

test("cssEscapeUrl prevents breaking out of url()", () => {
  assert.equal(cssEscapeUrl('a"b\\c'), 'a\\"b\\\\c');
});

test("the composer anchor: the card over the pane, a stray one ignored, none while it mounts", () => {
  const theme = computeComposerTheme(settings({ mode: "half-circle" }), null);
  assert.equal("--t3plus-composer-x" in theme.vars, false, "the theme does not own the anchor (resetting it made the glow jump on each thread switch)");

  const dom = new JSDOM(`<div data-workspace-area="conversation"><div data-chat-composer-surface="true"></div></div>
    <div data-chat-composer-surface="true" id="stray"></div>`);
  const doc = dom.window.document;
  const rect = (left, width) => () => ({ left, width, top: 0, height: 10, right: left + width, bottom: 10 });
  const host = doc.querySelector('[data-workspace-area="conversation"]');
  const composer = host.firstElementChild;
  host.getBoundingClientRect = rect(300, 1000);
  composer.getBoundingClientRect = rect(500, 600); // center 800 -> 50% of the pane
  doc.getElementById("stray").getBoundingClientRect = rect(0, 100);
  // A stray composer outside the pane comes first in the document; it must be ignored.
  doc.body.prepend(doc.getElementById("stray"));
  assert.equal(measureBackdropAnchor(doc).percent, 50);
  composer.getBoundingClientRect = rect(700, 600);
  assert.equal(measureBackdropAnchor(doc, host).percent, 70, "the pane given");
  // A composer that is mid-mount (not laid out): no anchor (the app keeps the last good one).
  composer.getBoundingClientRect = rect(300, 0);
  assert.equal(measureBackdropAnchor(doc), null);
});

test("the glow centers on T3's composer even though the composer overlay is a sibling of the pane (details panel open)", () => {
  // ChatView.tsx: <div data-workspace-area="conversation"> and the composer overlay are siblings.
  const dom = new JSDOM(`<div id="col"><div data-workspace-area="conversation"></div>
    <div data-chat-composer-overlay="true"><div data-chat-composer-surface="true" id="card"></div></div></div>`);
  const doc = dom.window.document;
  const rect = (left, width) => () => ({ left, width, top: 0, height: 10, right: left + width, bottom: 10 });
  doc.querySelector('[data-workspace-area="conversation"]').getBoundingClientRect = rect(300, 1400);
  doc.getElementById("card").getBoundingClientRect = rect(400, 700); // centered in the lane left of the details panel
  assert.equal(measureBackdropAnchor(doc).percent.toFixed(2), "32.14");
});

test("the Smooth look's glow follows the composer on the pane itself, never on <html>, and keeps its spot through a re-render", async () => {
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.settings, { composerGradient: { dither: false } });
  const dom = createDom("/env/thread", `<div data-workspace-area="conversation"></div>${T3_COMPOSER_HTML}`);
  const doc = dom.window.document;
  const rect = (left, width) => () => ({ left, width, top: 0, height: 40, right: left + width, bottom: 40 });
  const pane = doc.querySelector('[data-workspace-area="conversation"]');
  const card = doc.querySelector('[data-chat-composer-surface="true"]');
  pane.getBoundingClientRect = rect(300, 1000);
  card.getBoundingClientRect = rect(700, 600); // center 1000 -> 70%
  const { app } = createApp(dom, storage, { backdropRenderer: { update() {}, clear() {} } });
  await app.start();
  app.watcher.flush();
  assert.equal(pane.style.getPropertyValue("--t3plus-composer-x"), "70.00%");
  assert.equal(doc.documentElement.style.getPropertyValue("--t3plus-composer-x"), "", "on <html> each change restyled the whole page");
  await app.actions.setIntensity(80); // a re-render (a storage echo after a thread switch, a setting)
  app.watcher.flush();
  assert.equal(pane.style.getPropertyValue("--t3plus-composer-x"), "70.00%", "render keeps the anchor");
  card.getBoundingClientRect = rect(300, 0); // mid-mount: the last good spot stays
  await app.actions.setIntensity(70);
  app.watcher.flush();
  assert.equal(pane.style.getPropertyValue("--t3plus-composer-x"), "70.00%");
  app.stop();
});

test("the glow is t3+'s own layer in the pane: placing and resizing it never writes on <html>", () => {
  const dom = createDom("/env/thread", `<div data-workspace-area="conversation"><p>timeline</p></div>`);
  const doc = dom.window.document;
  const pane = doc.querySelector('[data-workspace-area="conversation"]');
  pane.getBoundingClientRect = () => ({ left: 200, top: 50, width: 1200, height: 800, right: 1400, bottom: 850 });
  // jsdom has no canvas: the colors come as bytes, and nothing is drawn (placing is what is tested).
  const renderer = createBackdropRenderer({ win: dom.window, doc, colorBytes: () => [51, 102, 255, 255], createCanvas: () => ({ getContext: () => null }) });
  const settings = { composerGradient: { intensity: 45, ditherSize: "medium", ditherStyle: "bayer", accent: "#3366ff" } };
  renderer.update({ mode: "half-circle", settings, imageSrc: null, host: pane, cx: 0.5, composerWidth: 700 });
  const layer = pane.firstElementChild;
  assert.ok(layer.classList.contains("t3plus-glow"), "first child of the pane");
  const pos = layer.querySelector(".t3plus-glow-pos");
  assert.match(pos.style.transform, /^translate\(600(\.00)?px, 8\d\d\.\d\dpx\)$/);
  const width = parseFloat(layer.querySelector(".t3plus-glow-near").style.width);
  assert.ok(Math.abs(width - 2 * 0.76 * 700) < 8, `sized from the message box (${width})`);
  assert.equal(doc.documentElement.style.length, 0, "nothing on <html>");
  renderer.update({ mode: "half-circle", settings, imageSrc: null, host: pane, cx: 0.4, composerWidth: 700, wide: true });
  assert.match(pos.style.transform, /^translate\(480(\.00)?px,/);
  assert.ok(layer.hasAttribute("data-wide"));
  assert.equal(doc.documentElement.style.length, 0);
  renderer.clear();
  assert.equal(pane.querySelector(".t3plus-glow"), null);
});
