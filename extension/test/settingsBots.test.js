import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { resolveBotPresentation } from "../src/bots.js";
import { DEFAULT_SETTINGS } from "../src/config.js";

// Settings -> t3+ -> Bots on its own: a chip per bot, one picker open at a time.
const windows = [];
after(() => windows.forEach((w) => w.close())); // even when a test fails part way

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  windows.push(dom.window);
  const doc = dom.window.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const bot = (key, label, preview = "") => ({ key, title: label, titleLabel: label, projectColor: null, prefs: { shape: null, color: "project" }, preview, view: resolveBotPresentation({ key, titleLabel: label }, {}) });
  const show = (bots) => panel.update({ settings: structuredClone(DEFAULT_SETTINGS), image: null, imageUrl: "", message: "", bots, botMarker: "🤖", health: [] });
  const chip = (key) => doc.querySelector(`.t3plus-bot-pick[data-bot-key="${key}"]`);
  const editor = () => doc.querySelector(".t3plus-bot-editor");
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { dom, doc, panel, calls, bot, show, chip, editor, key };
}

test("bots show as chips, A to Z; one picker opens at a time and the open chip closes it", () => {
  const t = setup();
  t.show([t.bot("e:3", "zeta"), t.bot("e:1", "Alpha"), t.bot("e:2", "beta")]);
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-bot-pick")].map((c) => c.textContent), ["Alpha", "beta", "zeta"]);
  assert.equal(t.editor(), null);
  t.chip("e:1").click();
  t.chip("e:2").click();
  assert.equal(t.doc.querySelectorAll(".t3plus-bot-editor").length, 1);
  assert.equal(t.editor().dataset.botKey, "e:2");
  assert.deepEqual([...t.doc.querySelectorAll('.t3plus-bot-pick[aria-expanded="true"]')].map((c) => c.dataset.botKey), ["e:2"]);
  t.chip("e:2").click();
  assert.equal(t.editor(), null);
  assert.equal(t.chip("e:2").getAttribute("aria-expanded"), "false");
});

test("Escape closes the picker, returns focus to its chip, and is marked handled for T3", () => {
  const t = setup();
  t.show([t.bot("e:1", "One"), t.bot("e:2", "Two")]);
  t.chip("e:2").click();
  let reached = false;
  t.doc.addEventListener("keydown", (e) => (reached = !e.defaultPrevented));
  t.key(t.doc.activeElement, "Escape");
  assert.equal(t.editor(), null);
  assert.equal(t.doc.activeElement, t.chip("e:2"));
  assert.equal(reached, false, "defaultPrevented: T3 leaves Settings open");
});

test("updates keep the picker open and the chips in place; a rename re-sorts without losing focus", () => {
  const t = setup();
  const bots = [t.bot("e:1", "Alpha", "hi"), t.bot("e:2", "Beta"), t.bot("e:3", "Gamma")];
  t.show(bots);
  t.chip("e:2").click();
  const chipEl = t.chip("e:2");
  for (let i = 0; i < 3; i += 1) t.show(bots);
  assert.equal(t.chip("e:2"), chipEl, "same node");
  assert.equal(t.editor().dataset.botKey, "e:2");
  t.chip("e:3").focus();
  t.show([bots[0], bots[1], t.bot("e:3", "Aardvark")]);
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-bot-pick")].map((c) => c.textContent), ["Aardvark", "Alpha", "Beta"]);
  assert.equal(t.doc.activeElement, t.chip("e:3"), "focus followed the chip");
  assert.equal(t.chip("e:1").title, "Alpha\nhi", "the tooltip has the latest message");
  t.show([{ ...bots[0], meta: "Opus 5.5 · Studio" }, bots[1], t.bot("e:3", "Aardvark")]);
  assert.equal(t.chip("e:1").title, "Alpha\nhi\nOpus 5.5 · Studio", "and its model and computer");
});

test("forgetting the open bot closes its picker and focuses the chip now in its place", () => {
  const t = setup();
  const bots = [t.bot("e:1", "A"), t.bot("e:2", "B"), t.bot("e:3", "C")];
  t.show(bots);
  t.chip("e:2").click();
  const forget = [...t.editor().querySelectorAll("button")].find((b) => b.textContent === "Forget");
  forget.focus();
  forget.click();
  assert.deepEqual(t.calls.at(-1), ["forgetBot", "e:2"]);
  t.show([bots[0], bots[2]]);
  assert.equal(t.editor(), null);
  assert.equal(t.doc.activeElement, t.chip("e:3"));
  // The last one: focus goes to the one before it.
  t.chip("e:3").click();
  t.show([bots[0]]);
  assert.equal(t.doc.activeElement, t.chip("e:1"));
});

test("leaving Settings closes the picker; same-named bots read apart by their latest message", () => {
  const t = setup();
  t.show([t.bot("e:1", "Review", "Fixed the parser."), t.bot("e:2", "Review", "Shipped 0.19.")]);
  t.chip("e:2").click();
  assert.equal(t.editor().querySelector(".t3plus-bot-message").textContent, "Shipped 0.19.");
  t.panel.closeBotEditor();
  assert.equal(t.editor(), null);
  assert.equal(t.chip("e:2").getAttribute("aria-expanded"), "false");
  t.chip("e:1").click();
  assert.equal(t.editor().querySelector(".t3plus-bot-message").textContent, "Fixed the parser.");
  t.show([t.bot("e:1", "Review"), t.bot("e:2", "Review")]);
  assert.equal(t.editor().querySelector(".t3plus-bot-message").hidden, true, "no message: no empty line");
});
