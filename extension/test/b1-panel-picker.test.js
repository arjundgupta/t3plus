import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { botArt, botStill, setBlobRasterizer, setBotArtEncoder } from "../src/botArt.js";
import { BOT_COLORS, BOT_SHAPES, BOT_STYLES, DEFAULT_SETTINGS } from "../src/config.js";
import { createDom } from "./helpers.js";

// Settings → t3+ → Subagents: the shape and color pickers (a button and a listbox), on the panel alone.
function setup() {
  const dom = createDom("/settings/appearance", "");
  const win = dom.window;
  const doc = win.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const scrolled = [];
  win.Element.prototype.scrollIntoView = function () {
    scrolled.push(this);
  };
  const show = (sidebar = {}) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.sidebar, sidebar);
    panel.update({ settings, image: null, imageUrl: "", message: "", bots: [], botMarker: "🤖", health: [] });
  };
  const trigger = (label) => doc.querySelector(`.t3plus-scope-pick[aria-label^="${label}"]`);
  const menu = (label) => trigger(label).parentElement.querySelector("[role=listbox]");
  const options = (label) => [...menu(label).querySelectorAll("[role=option]")];
  const active = (label) => menu(label).querySelector("[data-active]")?.dataset.value ?? null;
  const key = (el, k, extra = {}) => {
    const event = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra });
    el.dispatchEvent(event);
    return event;
  };
  const icon = (label, value) => menu(label).querySelector(`[data-value="${value}"] .t3plus-face-icon`);
  return { win, doc, panel, calls, scrolled, show, trigger, menu, options, active, key, icon };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHAPE = "Subagent shape";

test("a closed shape list draws no faces; the picked one is drawn for its button, the rest once the list opens", (t) => {
  // Counted where faces are made: a pixel face through the encoder, a blob still through the rasterizer.
  let grayFaces = 0;
  let blobSheets = 0;
  setBotArtEncoder((pixels, width, height, fills) => {
    if (fills[1] === BOT_COLORS.gray.stops[1]) grayFaces += 1;
    return null; // drawn as SVG, as without an encoder
  });
  setBlobRasterizer(() => {
    blobSheets += 1;
    return null;
  });
  t.after(() => {
    setBotArtEncoder(null);
    setBlobRasterizer(null);
  });
  const p = setup();
  p.show();
  // The one blob drawn: Bot style's Blobs face, in its segment.
  const styleBlobs = blobSheets;
  assert.equal(styleBlobs, 1, "Bot style's Blobs face");
  assert.equal(grayFaces, 0, "the bot's own on the button, nothing drawn for a closed list");
  p.show({ subagentShape: "robot" });
  assert.equal(grayFaces, 1, "the robot, for the button");
  assert.ok(p.trigger(SHAPE).querySelector(".t3plus-face-icon"));
  assert.equal(blobSheets, styleBlobs);
  p.trigger(SHAPE).click();
  const classic = Object.keys(BOT_SHAPES).filter((s) => !Object.values(BOT_STYLES).some((style) => style.shapes?.includes(s)));
  assert.equal(grayFaces, classic.length, "every classic shape in gray (the robot drawn once)");
  assert.equal(blobSheets - styleBlobs, BOT_STYLES.blobs.shapes.length, "and every blob");
  const shown = p.options(SHAPE);
  assert.equal(shown.length, 1 + Object.keys(BOT_SHAPES).length);
  assert.ok(shown.slice(1).every((o) => o.querySelector(".t3plus-face-icon")), "each shape with its face");
  p.trigger(SHAPE).click();
  p.trigger(SHAPE).click();
  assert.equal(grayFaces, classic.length, "opened again: nothing drawn again");
});

test("the faces are subagents' as the sidebar draws them: still, in the color picked; balls, planets and fruit in their own colors, with no ring", () => {
  const p = setup();
  p.show();
  p.trigger(SHAPE).click();
  const fill = (value) => p.icon(SHAPE, value).style.getPropertyValue("--t3plus-bot-fill");
  /** What a ring drew on an icon: its mark and its color. */
  const ringed = (icon) => icon.hasAttribute("data-t3plus-ring") || icon.style.getPropertyValue("--t3plus-bot-edge") !== "";
  assert.equal(fill("drop"), botStill("gray", "drop").url, "the bot's own color: gray, one frame");
  assert.notEqual(fill("drop"), botArt("gray", "drop", "awake").url, "not the moving sheet");
  p.show({ subagentColor: "purple" });
  assert.equal(fill("drop"), botStill("purple", "drop").url, "the open list follows the color picked");
  assert.equal(fill("robot"), botStill("purple", "robot").url);
  p.show({ subagentColor: "red" });
  const soccer = p.icon(SHAPE, "soccer");
  assert.equal(ringed(soccer), false, "a ball keeps its own colors, no ring in red");
  assert.equal(fill("soccer"), botStill("red", "soccer").url, "the ball as it is");
  assert.equal(soccer.style.getPropertyValue("--t3plus-bot-clip"), BOT_SHAPES.soccer, "in its own clip");
  assert.equal(p.icon(SHAPE, "saturn").style.getPropertyValue("--t3plus-bot-clip"), BOT_SHAPES.saturn, "a planet with sky in its own clip, as in the sidebar");
  assert.equal(ringed(p.icon(SHAPE, "robot")), false, "a classic shape takes the color itself");
  p.key(p.menu(SHAPE), "Escape");
  p.show({ subagentColor: "red", subagentShape: "soccer" });
  assert.equal(ringed(p.trigger(SHAPE).querySelector(".t3plus-face-icon")), false, "its button neither");
});

test("an open list is left as it is by an update with nothing new: same options, same one active, no jump back to it", () => {
  const p = setup();
  p.show();
  p.trigger(SHAPE).click();
  const menu = p.menu(SHAPE);
  for (let i = 0; i < 3; i += 1) p.key(menu, "ArrowDown");
  const before = p.options(SHAPE);
  const activeId = menu.getAttribute("aria-activedescendant");
  const records = new p.win.MutationObserver(() => {});
  records.observe(menu, { childList: true, subtree: true, attributes: true });
  p.scrolled.length = 0;
  p.show(); // a feed read, a storage echo: nothing for this list
  assert.deepEqual(records.takeRecords(), [], "nothing rebuilt or rewritten");
  assert.ok(p.options(SHAPE).every((o, i) => o === before[i]));
  assert.equal(menu.getAttribute("aria-activedescendant"), activeId, "not announced again");
  assert.equal(p.scrolled.length, 0, "a list scrolled by the wheel stays where it is");
  // A change it shows (another color for the faces): drawn again, the same one active, by the same id.
  p.show({ subagentColor: "purple" });
  assert.notEqual(p.options(SHAPE)[1], before[1], "drawn again");
  assert.equal(menu.getAttribute("aria-activedescendant"), activeId);
  assert.equal(p.active(SHAPE), before[3].dataset.value);
  assert.equal(p.scrolled.length, 0);
  records.disconnect();
});

test("the pointer moves the active option without scrolling the list; keys bring it into view", () => {
  const p = setup();
  p.show();
  p.trigger(SHAPE).click();
  p.scrolled.length = 0;
  const robot = p.menu(SHAPE).querySelector('[data-value="robot"] .t3plus-scope-option-text');
  robot.dispatchEvent(new p.win.MouseEvent("pointermove", { bubbles: true }));
  assert.equal(p.active(SHAPE), "robot");
  assert.equal(p.menu(SHAPE).querySelectorAll("[data-active]").length, 1, "one active");
  assert.equal(p.scrolled.length, 0, "hovering did not move the list under the pointer");
  p.key(p.menu(SHAPE), "ArrowDown");
  assert.equal(p.active(SHAPE), "heart");
  assert.deepEqual(p.scrolled.map((o) => o.dataset.value), ["heart"], "a key move is kept in view");
});

test("type-ahead: a letter moves to the next option it starts, again steps on, more letters narrow; modifiers are T3's", async () => {
  const p = setup();
  p.show();
  p.trigger(SHAPE).click();
  const menu = p.menu(SHAPE);
  assert.equal(p.key(menu, "w").defaultPrevented, true);
  assert.equal(p.active(SHAPE), "watermelon");
  p.key(menu, "w");
  assert.equal(p.active(SHAPE), "wobble", "the same letter again: the next one it starts");
  p.key(menu, "w");
  assert.equal(p.active(SHAPE), "watermelon", "and round again");
  await wait(550); // a pause starts a new word
  p.key(menu, "b");
  assert.equal(p.active(SHAPE), "bean", "the next after the active one");
  p.key(menu, "e");
  p.key(menu, "a");
  assert.equal(p.active(SHAPE), "bean", "still matches: stays");
  p.key(menu, "c");
  assert.equal(p.active(SHAPE), "beachball", "narrowed past it, round from the top");
  assert.equal(p.key(menu, "q", { metaKey: true }).defaultPrevented, false, "⌘Q is not typed");
  assert.equal(p.active(SHAPE), "beachball");
  await wait(550);
  // A space while a name is typed is part of it; after a pause it picks.
  for (const k of ["b", "o", "t", "'", "s", " "]) p.key(menu, k);
  assert.equal(p.active(SHAPE), "same");
  assert.equal(menu.hidden, false, "the space was typed, not a pick");
  await wait(550);
  p.key(menu, "r");
  assert.equal(p.active(SHAPE), "robot");
  await wait(550);
  p.key(menu, " ");
  assert.equal(menu.hidden, true);
  assert.deepEqual(p.calls.at(-1), ["setSidebarFeature", "subagentShape", "robot"]);
});

test("each picker's own first option reads apart; the menu starts on the one picked", () => {
  const p = setup();
  p.show();
  assert.equal(p.trigger(SHAPE).textContent, "Bot's shape");
  assert.equal(p.trigger("Subagent color").textContent, "Bot's color");
  assert.equal(p.trigger(SHAPE).getAttribute("aria-label"), "Subagent shape: Bot's shape");
  p.show({ subagentShape: "moon" });
  p.trigger(SHAPE).click();
  assert.equal(p.active(SHAPE), "moon");
  assert.equal(p.menu(SHAPE).querySelector('[aria-selected="true"]').dataset.value, "moon");
});
