import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { DEFAULT_SETTINGS } from "../src/config.js";

// Settings -> t3+ -> Profiles on its own: pick a profile, its icon and three colors, with a preview.
const windows = [];
after(() => windows.forEach((w) => w.close()));

function setup({ list, active = list[0].id, sky = true, demo = false, settings = structuredClone(DEFAULT_SETTINGS) } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  windows.push(dom.window);
  const doc = dom.window.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => (calls.push([name, ...args]), name === "profileSkyTurn" ? 42 : undefined) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  settings.demo.enabled = demo;
  const show = (profiles, s = settings) => panel.update({ settings: s, image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [], profiles });
  show({ list, active, sky });
  const card = () => doc.querySelector(".t3plus-pp-body").closest(".t3plus-card");
  const row = (field) => doc.querySelector(`.t3plus-pp-row[data-field="${field}"]`);
  return { dom, doc, panel, calls, show, card, row, settings };
}
const LIST = [
  { id: "main", name: "Main", color: "default", sky: "default", dither: "default" },
  { id: "work", name: "Work", color: "blue", sky: "teal", dither: "#22d3ee", icon: "rocket" },
];

test("the card lists the profiles (the open one picked) and edits the one picked", () => {
  const t = setup({ list: LIST, active: "work" });
  assert.equal(t.card().hidden, false);
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-pp-chip")].map((c) => c.textContent), ["Main", "Work"]);
  assert.equal(t.doc.querySelector('.t3plus-pp-chip[aria-checked="true"]').textContent, "Work");
  assert.ok(t.doc.querySelector('.t3plus-pp-chip[data-profile="work"] svg'), "its icon on its chip");
  t.row("color").querySelector('[aria-label="Pink"]').click();
  assert.deepEqual(t.calls.find((c) => c[0] === "updateProfile").slice(1), ["work", { color: "pink" }]);
  t.doc.querySelector('.t3plus-pp-chip[data-profile="main"]').click();
  t.doc.querySelector('.t3plus-pp-icons [aria-label="Star"]').click();
  assert.deepEqual(t.calls.filter((c) => c[0] === "updateProfile").at(-1).slice(1), ["main", { icon: "star" }]);
  assert.equal(t.panel.profilePreviewAccent(), null, "Main's dither: the glow's own");
});

test("a custom color: the button is the picked one, the presets keep a Tab stop; dragging previews, letting go saves, a cancelled pick is dropped", () => {
  const t = setup({ list: LIST, active: "work" });
  const dither = t.row("dither");
  const custom = dither.querySelector(".t3plus-pp-custom");
  assert.ok(custom.hasAttribute("data-checked"), "#22d3ee is a custom color");
  assert.equal(dither.querySelectorAll('[role=radio][aria-checked="true"]').length, 0);
  assert.equal([...dither.querySelectorAll("[role=radio]")].filter((r) => r.tabIndex === 0).length, 1, "one Tab stop into the presets");
  assert.equal(t.panel.profilePreviewAccent(), "#22d3ee");
  custom.value = "#ff0000";
  custom.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  assert.equal(t.panel.profilePreviewAccent(), "#ff0000", "previewed while dragged");
  assert.equal(t.calls.some((c) => c[0] === "updateProfile"), false, "not saved yet");
  custom.dispatchEvent(new t.dom.window.Event("blur"));
  assert.equal(t.panel.profilePreviewAccent(), "#22d3ee", "a pick never let go is dropped");
  custom.value = "#00ff00";
  custom.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  custom.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
  assert.deepEqual(t.calls.filter((c) => c[0] === "updateProfile").at(-1).slice(1), ["work", { dither: "#00ff00" }]);
});

test("the preview: the name and dots, the sky turned, the glow in the dither color; off when the background is not the glow", () => {
  const t = setup({ list: LIST, active: "work" });
  const sky = t.doc.querySelector(".t3plus-pp-sky");
  assert.equal(sky.getAttribute("data-tint"), "", "the sky is turned");
  assert.equal(sky.style.getPropertyValue("--t3plus-sky-turn"), "42.0");
  assert.equal(t.doc.querySelector(".t3plus-pp-name").textContent, "Work");
  assert.equal(t.doc.querySelector(".t3plus-pp-pane").style.getPropertyValue("--t3plus-accent"), "#22d3ee");
  assert.equal(t.doc.querySelector(".t3plus-pp-pane").hasAttribute("data-glow-off"), false);
  const image = structuredClone(t.settings);
  image.composerGradient.mode = "image";
  t.show({ list: LIST, active: "work", sky: true }, image);
  assert.equal(t.doc.querySelector(".t3plus-pp-pane").hasAttribute("data-glow-off"), true, "an image: no glow to color");
  t.show({ list: LIST, active: "work", sky: false });
  assert.equal(t.row("sky").hidden, true, "no Sky row where T3 draws no sky");
});

test("screenshot mode names them Profile 1, Profile 2; no profiles (off, or not loaded yet): no card", () => {
  const t = setup({ list: LIST, demo: true });
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-pp-chip")].map((c) => c.textContent), ["Profile 1", "Profile 2"]);
  assert.equal(t.doc.querySelector(".t3plus-pp-name").textContent, "Profile 1");
  t.show(null);
  assert.equal(t.card().hidden, true);
});
