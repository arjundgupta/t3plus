import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { botStill } from "../src/botArt.js";
import { resolveBotPresentation } from "../src/bots.js";
import { BOT_SHAPES, BOT_STYLES, DEFAULT_SETTINGS } from "../src/config.js";
import { createDom } from "./helpers.js";

// Settings → t3+: the bot editor, on the panel alone.
function setup() {
  const dom = createDom("/settings/appearance", "");
  const doc = dom.window.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const bot = (key, label, prefs) => ({ key, title: label, titleLabel: label, projectColor: null, prefs, preview: "", view: resolveBotPresentation({ key, titleLabel: label }, prefs) });
  const show = (bots) => panel.update({ settings: structuredClone(DEFAULT_SETTINGS), image: null, imageUrl: "", message: "", bots, botMarker: "🤖", health: [] });
  const editor = () => doc.querySelector(".t3plus-bot-editor");
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { dom, doc, panel, calls, bot, show, editor, key };
}

test("the bot editor is one Tab stop per set: arrow keys, Home and End move within it, Enter or Space picks", () => {
  const p = setup();
  p.show([p.bot("e:1", "Alpha", { shape: "diamond", color: "blue" })]);
  const tabbable = [...p.editor().querySelectorAll("button, [tabindex]")].filter((el) => el.tabIndex >= 0);
  assert.ok(tabbable.length <= 7, `${tabbable.length} Tab stops: one per set, and Forget`);
  const sets = [...p.editor().querySelectorAll(".t3plus-swatches")];
  for (const set of sets) {
    assert.equal(set.getAttribute("role"), "toolbar");
    assert.equal([...set.querySelectorAll("button")].filter((b) => b.tabIndex === 0).length, 1, set.getAttribute("aria-label"));
  }
  const diamond = p.editor().querySelector('button[data-value="diamond"]');
  assert.equal(diamond.tabIndex, 0, "the pressed one is the stop");
  diamond.focus();
  p.key(diamond, "ArrowRight");
  const next = diamond.nextElementSibling;
  assert.equal(p.doc.activeElement, next);
  assert.equal(next.tabIndex, 0, "the stop follows the focus");
  assert.equal(diamond.tabIndex, -1);
  assert.deepEqual(p.calls.filter(([name]) => name === "updateBot"), [], "moving is not picking");
  p.key(next, "End");
  assert.equal(p.doc.activeElement, next.parentElement.lastElementChild);
  p.key(p.doc.activeElement, "Home");
  assert.equal(p.doc.activeElement, next.parentElement.firstElementChild);
  p.doc.activeElement.click();
  assert.deepEqual(p.calls.at(-1), ["updateBot", "e:1", { shape: next.parentElement.firstElementChild.dataset.value }]);
});

test("the editor's swatches are one still face each, a Blobs shape too (not its whole animated sheet)", () => {
  const p = setup();
  p.show([p.bot("e:1", "Alpha", { shape: "pebble", color: "blue" })]);
  for (const mark of p.editor().querySelectorAll('[data-field="shape"] .t3plus-swatch-mark')) {
    const shape = mark.parentElement.dataset.value;
    assert.equal(mark.style.getPropertyValue("--t3plus-bot-fill"), botStill("blue", shape).url, shape);
  }
});

test("Classic keeps its teardrop: the Blobs set's names are no other shape's", () => {
  assert.match(BOT_SHAPES.teardrop, /^polygon\(/);
  const themed = Object.values(BOT_STYLES).flatMap((s) => s.shapes ?? []);
  assert.equal(new Set(themed).size, themed.length, "no shape in two sets");
  const p = setup();
  p.show([p.bot("e:1", "Alpha", { shape: "circle", color: "blue" })]);
  assert.ok(p.editor().querySelector('[data-set="Classic"] button[data-value="teardrop"]'));
  assert.ok(p.editor().querySelector('[data-set="Blobs"] button[data-value="drop"]'));
});

test("leaving Settings closes an open menu, and takes its listener off the document", () => {
  const p = setup();
  p.dom.window.Element.prototype.scrollIntoView = () => {};
  p.show([p.bot("e:1", "Alpha", { shape: "circle", color: "blue" })]);
  const trigger = p.doc.querySelector('.t3plus-scope-pick[aria-label^="Subagent shape"]');
  const menu = trigger.parentElement.querySelector("[role=listbox]");
  const listeners = [];
  const remove = p.doc.removeEventListener;
  p.doc.removeEventListener = (type, ...rest) => (listeners.push(type), remove.call(p.doc, type, ...rest));
  trigger.click();
  assert.equal(menu.hidden, false);
  p.panel.leave(); // the app, as Settings is left (and on stop)
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.deepEqual(listeners, ["pointerdown"]);
});

test("the teardrop is drawn as a pixel face, as Classic's drop was before Blobs took its name", async () => {
  const { botArt } = await import("../src/botArt.js");
  const art = botArt("blue", "teardrop", "awake");
  assert.notEqual(art.url, botArt("blue", "drop", "awake").url, "not the blob");
  assert.notEqual(art.url, botArt("blue", "circle", "awake").url, "its own eyes, not a fallback");
});

test("Settings promises right-click → Move to profile only where T3's folder menu has it (the desktop app)", () => {
  for (const desktop of [false, true]) {
    const dom = createDom("/settings/appearance", "");
    const panel = createAppearancePanel(dom.window.document, new Proxy({}, { get: () => () => {} }), { desktop });
    assert.equal(panel.element.textContent.includes("Move to profile"), desktop, desktop ? "desktop" : "extension");
  }
});
