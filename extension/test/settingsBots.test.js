import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { resolveBotPresentation } from "../src/bots.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { closeWhenDone } from "./helpers.js";

// Settings -> t3+ -> Bots on its own: a chip per bot, one picker open at a time.

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  closeWhenDone(dom.window); // even when a test fails part way
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

const names = (t) => [...t.doc.querySelectorAll(".t3plus-bot-pick:not([hidden]) .t3plus-bot-name")].map((n) => n.textContent);
const picked = (t) => t.doc.querySelector('.t3plus-bot-pick[aria-selected="true"]')?.dataset.botKey ?? null;

test("bots in a list, A to Z; the first is picked and shown on the right; one at a time", () => {
  const t = setup();
  t.show([t.bot("e:3", "zeta"), t.bot("e:1", "Alpha"), t.bot("e:2", "beta")]);
  assert.deepEqual(names(t), ["Alpha", "beta", "zeta"]);
  assert.equal(picked(t), "e:1");
  assert.equal(t.editor().dataset.botKey, "e:1");
  t.chip("e:3").click();
  assert.equal(t.doc.querySelectorAll(".t3plus-bot-editor").length, 1);
  assert.equal(t.editor().dataset.botKey, "e:3");
  assert.equal(picked(t), "e:3");
  t.chip("e:3").click(); // the one picked again: stays
  assert.equal(t.editor().dataset.botKey, "e:3");
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-bot-pick")].filter((c) => c.tabIndex === 0).map((c) => c.dataset.botKey), ["e:3"], "one Tab stop: the one picked");
});

test("search narrows the list; Escape clears it (marked handled for T3); ArrowDown goes into the list, arrows pick as they move", () => {
  const t = setup();
  t.show([t.bot("e:1", "Alpha"), t.bot("e:2", "Beta"), t.bot("e:3", "Gamma"), t.bot("e:4", "Alphabet")]);
  const search = t.doc.querySelector(".t3plus-bots-search");
  search.value = "alp";
  search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(names(t), ["Alpha", "Alphabet"]);
  search.value = "nothing";
  search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  assert.equal(t.doc.querySelector(".t3plus-bots-none").hidden, false, "says none match");
  let reached = false;
  t.doc.addEventListener("keydown", (e) => (reached = !e.defaultPrevented));
  t.key(search, "Escape");
  assert.equal(search.value, "");
  assert.equal(names(t).length, 4);
  assert.equal(reached, false, "defaultPrevented: T3 leaves Settings open");
  t.key(search, "ArrowDown");
  assert.equal(t.doc.activeElement, t.chip("e:1"));
  t.key(t.doc.activeElement, "ArrowDown");
  assert.equal(t.doc.activeElement, t.chip("e:4"), "Alphabet: second A to Z");
  assert.equal(picked(t), "e:4");
  t.key(t.doc.activeElement, "End");
  assert.equal(picked(t), "e:3");
});

test("updates keep the bot picked and the list in place; a rename re-sorts without losing focus; tooltips carry message and model", () => {
  const t = setup();
  const bots = [t.bot("e:1", "Alpha", "hi"), t.bot("e:2", "Beta"), t.bot("e:3", "Gamma")];
  t.show(bots);
  t.chip("e:2").click();
  const chipEl = t.chip("e:2");
  const editorEl = t.editor();
  t.show(bots);
  assert.equal(t.chip("e:2"), chipEl, "the same element");
  assert.equal(t.editor(), editorEl);
  assert.equal(t.chip("e:1").title, "Alpha\nhi");
  assert.equal(t.chip("e:1").querySelector(".t3plus-bot-line").textContent, "hi");
  chipEl.focus();
  t.show([bots[0], { ...t.bot("e:2", "Zulu"), meta: "Opus 5.5 · Studio" }, bots[2]]);
  assert.deepEqual(names(t), ["Alpha", "Gamma", "Zulu"]);
  assert.equal(t.doc.activeElement, chipEl, "focus kept through the re-sort");
  assert.equal(t.chip("e:2").title, "Zulu\nOpus 5.5 · Studio");
  assert.equal(t.editor().querySelector(".t3plus-bot-meta").textContent, "Opus 5.5 · Studio");
});

test("forgetting the bot picked picks the one now in its place (focus too); the last picks the one before", () => {
  const t = setup();
  const [a, b, c] = [t.bot("e:1", "A"), t.bot("e:2", "B"), t.bot("e:3", "C")];
  t.show([a, b, c]);
  t.chip("e:2").click();
  t.editor().querySelector("button").focus();
  t.show([a, c]);
  assert.equal(picked(t), "e:3");
  assert.equal(t.doc.activeElement, t.chip("e:3"));
  t.chip("e:3").click();
  t.editor().querySelector("button").focus();
  t.show([a]);
  assert.equal(picked(t), "e:1");
  assert.equal(t.doc.activeElement, t.chip("e:1"));
  t.show([]);
  assert.equal(t.doc.querySelector(".t3plus-bots-both").hidden, true, "no bots: no list");
});

test("leaving Settings clears the search; same-named bots read apart by their latest message", () => {
  const t = setup();
  t.show([t.bot("e:1", "Review", "Looks good"), t.bot("e:2", "Review", "Two issues found")]);
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-bot-line")].map((l) => l.textContent), ["Looks good", "Two issues found"]);
  const search = t.doc.querySelector(".t3plus-bots-search");
  search.value = "x";
  search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  t.panel.leave();
  assert.equal(search.value, "");
  assert.equal(names(t).length, 2);
  t.show([t.bot("e:1", "Quiet")]);
  assert.equal(t.editor().querySelector(".t3plus-bot-message").textContent, "No messages yet");
});

test("a search hiding the bot picked leaves a Tab stop on one shown; the focused bot leaving keeps the focus in the list; not a live region", () => {
  const t = setup();
  t.show([t.bot("e:1", "Alpha"), t.bot("e:2", "Beta"), t.bot("e:3", "Gamma")]);
  const search = t.doc.querySelector(".t3plus-bots-search");
  search.value = "bet";
  search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  assert.deepEqual([...t.doc.querySelectorAll(".t3plus-bot-pick")].filter((c) => c.tabIndex === 0).map((c) => c.dataset.botKey), ["e:2"], "Alpha is searched out: Beta is the stop");
  search.value = "";
  search.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
  t.chip("e:2").click();
  t.chip("e:2").focus();
  t.show([t.bot("e:1", "Alpha"), t.bot("e:3", "Gamma")]); // Beta leaves while focused
  assert.equal(t.doc.activeElement, t.chip("e:3"), "the one in its place");
  assert.equal(t.doc.querySelector(".t3plus-bot-slot").hasAttribute("aria-live"), false);
});
