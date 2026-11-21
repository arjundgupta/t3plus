import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { closeWhenDone } from "./helpers.js";

// Settings -> t3+ -> Profiles on its own: pick a profile, its icon and three colors, with a preview.

function setup({ list, active = list[0].id, sky = true, demo = false, settings = structuredClone(DEFAULT_SETTINGS) } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  closeWhenDone(dom.window); // even when a test fails part way
  const doc = dom.window.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => (calls.push([name, ...args]), name === "profileSkyTurn" ? 42 : undefined) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  settings.demo.enabled = demo;
  // Each profile's glow color, as the app resolves it from its settings (settingsScopes.js).
  const show = (profiles, s = settings) => panel.update({ settings: s, image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [], profiles, profileAccents: { work: "#22d3ee" } });
  show({ list, active, sky });
  const card = () => doc.querySelector(".t3plus-pp-body").closest(".t3plus-card");
  const row = (field) => doc.querySelector(`.t3plus-pp-row[data-field="${field}"]`);
  return { dom, doc, panel, calls, show, card, row, settings };
}
const LIST = [
  { id: "main", name: "Main", color: "default", sky: "default" },
  { id: "work", name: "Work", color: "blue", sky: "#22d3ee", icon: "rocket" },
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
  assert.equal(t.panel.profilePreviewAccent(), null, "Main has no glow of its own");
});

test("a custom color: the button is the picked one, the presets keep a Tab stop; dragging previews, letting go saves, a cancelled pick is dropped", () => {
  const t = setup({ list: LIST, active: "work" });
  const sky = t.row("sky");
  const custom = sky.querySelector(".t3plus-pp-custom");
  const turnAskedFor = () => t.calls.filter((c) => c[0] === "profileSkyTurn").at(-1)?.[1];
  assert.ok(custom.hasAttribute("data-checked"), "#22d3ee is a custom color");
  assert.equal(sky.querySelectorAll('[role=radio][aria-checked="true"]').length, 0);
  assert.equal([...sky.querySelectorAll("[role=radio]")].filter((r) => r.tabIndex === 0).length, 1, "one Tab stop into the presets");
  assert.equal(turnAskedFor(), "#22d3ee");
  custom.value = "#ff0000";
  custom.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  assert.equal(turnAskedFor(), "#ff0000", "previewed while dragged");
  assert.equal(t.calls.some((c) => c[0] === "updateProfile"), false, "not saved yet");
  custom.dispatchEvent(new t.dom.window.Event("blur"));
  assert.equal(turnAskedFor(), "#22d3ee", "a pick never let go is dropped");
  custom.value = "#00ff00";
  custom.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  custom.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
  assert.deepEqual(t.calls.filter((c) => c[0] === "updateProfile").at(-1).slice(1), ["work", { sky: "#00ff00" }]);
});

test("the preview: the name and dots, the sky turned, the glow in the profile's own glow color; off when the background is not the glow", () => {
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

test("chat bubbles: T3's, a preset or your own; a profile's own is a setting (the scope bar), not a Profiles row", () => {
  const t = setup({ list: LIST });
  const group = t.doc.querySelector('[role=radiogroup][aria-label="Chat bubble color"]');
  assert.ok(group, "a row in the look card");
  const picked = () => group.querySelector('[aria-checked="true"]')?.getAttribute("aria-label") ?? null;
  assert.equal(picked(), "T3's", "T3's own by default");
  group.querySelector('[aria-label="Blue"]').click();
  assert.deepEqual(t.calls.at(-1), ["setBubble", "#3b82f6"]);
  group.querySelector('[aria-label="T3\'s"]').click();
  assert.deepEqual(t.calls.at(-1), ["setBubble", "theme"]);
  const blue = structuredClone(t.settings);
  blue.chat.bubble = "#3b82f6";
  t.show({ list: LIST, active: "main", sky: true }, blue);
  assert.equal(picked(), "Blue");
  const custom = t.doc.querySelector('[aria-label="Custom chat bubble color"]');
  const own = structuredClone(t.settings);
  own.chat.bubble = "#123456";
  t.show({ list: LIST, active: "main", sky: true }, own);
  assert.equal(picked(), null, "a custom one: no preset picked");
  assert.equal(custom.hasAttribute("data-checked"), true);
  assert.equal(custom.value, "#123456");
  custom.value = "#abcdef";
  custom.dispatchEvent(new t.dom.window.Event("input"));
  assert.deepEqual(t.calls.at(-1), ["previewBubble", "#abcdef"]);
  custom.dispatchEvent(new t.dom.window.Event("change"));
  assert.deepEqual(t.calls.at(-1), ["setBubble", "#abcdef"]);
  assert.equal(t.row("bubble"), null, "the Profiles card has no bubble row of its own");
  assert.equal(t.row("dither"), null, "nor a glow one");
});
