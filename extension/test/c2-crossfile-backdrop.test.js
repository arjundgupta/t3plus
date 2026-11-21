import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackdropRenderer } from "../src/backdropRenderer.js";
import { normalizeSettings } from "../src/settings.js";
import { createDom, virtualClock } from "./helpers.js";

// The renderer with its canvas and colors stood in for: what it draws, keeps, shows and
// releases, without a real canvas, on a clock the test moves (on the real one a loaded
// machine had a render still under way when the test looked).
function setup({ keep = 18, failWhen = () => false } = {}) {
  const dom = createDom("/env/t", `<div id="pane"></div>`);
  const win = dom.window;
  const clock = virtualClock(win);
  const counts = { blobs: 0, created: 0, revoked: 0 };
  win.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  win.URL.createObjectURL = () => `blob:x/${(counts.created += 1)}`;
  win.URL.revokeObjectURL = () => (counts.revoked += 1);
  let accent = null;
  const createCanvas = () => ({
    getContext: () => ({ putImageData() {} }),
    toBlob: (done) => {
      counts.blobs += 1;
      setTimeout(() => done(failWhen(accent) ? null : new win.Blob(["png"])), 1);
    },
  });
  const colorBytes = (doc, css) => (/^#[0-9a-f]{6}$/i.test(css) ? [...[1, 3, 5].map((i) => Number.parseInt(css.slice(i, i + 2), 16)), 255] : [10, 10, 10, 255]);
  const renderer = createBackdropRenderer({ win, doc: win.document, delayMs: 5, keep, colorBytes, createCanvas });
  const pane = win.document.getElementById("pane");
  const rect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };
  const show = (color, host = pane) => {
    accent = color;
    renderer.update({ mode: "half-circle", settings: normalizeSettings({ composerGradient: { accent: color } }), host, hostRect: rect, cx: 0.5, composerWidth: 200 });
  };
  const near = () => pane.querySelector(".t3plus-glow-near")?.style.backgroundImage ?? "";
  const settle = (ms = 150) => clock.advance(ms);
  return { win, doc: win.document, renderer, counts, show, near, pane, settle };
}

test("a render that fails shows the CSS fallback, and a later color recovers", async () => {
  const t = setup({ failWhen: (color) => color === "#ff0000" });
  t.show("#ff0000");
  await t.settle();
  assert.equal(t.doc.documentElement.hasAttribute("data-t3plus-dithered"), false, "the fallback shows");
  assert.equal(t.pane.querySelector(".t3plus-glow"), null);
  t.show("#ff0000");
  await t.settle();
  assert.equal(t.counts.blobs, 1, "the failed one is not drawn again on every check");
  t.show("#00ff00");
  await t.settle();
  assert.match(t.near(), /blob:x\//, "drawn and shown");
  assert.ok(t.doc.documentElement.hasAttribute("data-t3plus-dithered"));
  t.renderer.clear();
});

test("a page without a pane keeps the renders: back on one, the glow shows at once", async () => {
  const t = setup();
  t.show("#3366ff");
  await t.settle();
  const drawn = t.counts.blobs;
  t.show("#3366ff", null); // a Settings page, Usage
  assert.equal(t.pane.querySelector(".t3plus-glow"), null, "the layer leaves");
  t.show("#3366ff");
  assert.match(t.near(), /blob:x\//, "shown in the same update");
  await t.settle();
  assert.equal(t.counts.blobs, drawn, "nothing drawn again");
  t.renderer.clear();
  assert.equal(t.counts.created, t.counts.revoked, "clear releases every image");
});

test("cleared while a render is under way, it never shows that render, and leaks no image", async () => {
  const t = setup();
  t.show("#3366ff");
  await t.settle(0);
  t.renderer.clear();
  await t.settle();
  assert.equal(t.pane.querySelector(".t3plus-glow"), null);
  assert.equal(t.counts.created, t.counts.revoked);
});

test("past `keep` renders, the oldest are released: live images stay bounded", async () => {
  const t = setup({ keep: 3 });
  for (const color of ["#110000", "#220000", "#330000", "#440000", "#550000", "#660000"]) {
    t.show(color);
    await t.settle(40);
  }
  await t.settle(1100); // past the grace a replaced image gets
  assert.ok(t.counts.created - t.counts.revoked <= 2 * 3, `${t.counts.created - t.counts.revoked} images alive`);
  t.renderer.clear();
  assert.equal(t.counts.created, t.counts.revoked);
});

test("a theme color not there yet (T3's styles still loading) is read again a little later, not kept for the theme", async () => {
  const t = setup();
  let now = 0;
  t.win.performance.now = () => now;
  let primary = "";
  const reads = [];
  const computed = t.win.getComputedStyle.bind(t.win);
  t.win.getComputedStyle = (el) => {
    const style = computed(el);
    return { getPropertyValue: (name) => (name === "--primary" ? (reads.push(name), primary) : style.getPropertyValue(name)) };
  };
  t.show("theme");
  t.show("theme");
  assert.equal(reads.length, 1, "within a moment, the fallback is not read again on every update");
  primary = "#22aa44";
  now += 3500;
  t.show("theme");
  assert.equal(reads.length, 2, "read again once T3's styles had time to arrive");
  t.show("theme");
  assert.equal(reads.length, 2, "a real value is kept for the theme");
  t.renderer.clear();
});
