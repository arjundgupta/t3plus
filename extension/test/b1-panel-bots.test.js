import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { botFillUrl } from "../src/botArt.js";
import { botPaintColor, resolveBotPresentation } from "../src/bots.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { spriteCount } from "../src/spriteClock.js";
import { createApp, createDom, settle, T3_APPEARANCE_HTML } from "./helpers.js";

// Settings → t3+: the Bots card's editor and the live preview's bots, on the panel alone.
function setup() {
  const dom = createDom("/settings/appearance", "");
  const win = dom.window;
  const doc = win.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const bot = (key, label, prefs = {}) => {
    const p = { shape: prefs.shape ?? "auto", color: prefs.color ?? "project" };
    return { key, title: label, titleLabel: label, projectColor: null, prefs: p, preview: "", view: resolveBotPresentation({ key, titleLabel: label }, p) };
  };
  const show = (bots, sidebar = {}) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.sidebar, sidebar);
    panel.update({ settings, image: null, imageUrl: "", message: "", bots, botMarker: "🤖", health: [] });
  };
  const editor = () => doc.querySelector(".t3plus-bot-editor");
  const marks = (field) => [...editor().querySelectorAll(`[data-field="${field}"] .t3plus-swatch-mark`)];
  return { win, doc, panel, calls, bot, show, editor, marks };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready()` holds, for up to `ms` (the sprite clock steps on timers of its own). */
async function until(ready, ms = 3000) {
  for (const end = Date.now() + ms; !ready() && Date.now() < end; ) await wait(20);
  return ready();
}

test("an update with nothing new paints no swatch again; a new color paints the shapes in it", (t) => {
  const p = setup();
  const bots = [p.bot("e:1", "Alpha", { shape: "circle", color: "blue" })];
  p.show(bots);
  const swatchStyles = new Set([...p.marks("shape"), ...p.marks("color")].map((m) => m.style));
  const writes = [];
  const proto = p.win.CSSStyleDeclaration.prototype;
  const setProperty = proto.setProperty;
  proto.setProperty = function (name, ...rest) {
    if (swatchStyles.has(this)) writes.push(name);
    return setProperty.call(this, name, ...rest);
  };
  t.after(() => (proto.setProperty = setProperty));
  const records = new p.win.MutationObserver(() => {});
  records.observe(p.editor(), { attributes: true, childList: true, subtree: true });
  p.show(bots); // a slider step, a feed read: this bot unchanged
  assert.deepEqual(writes, [], "58 faces were sent again on every update");
  assert.deepEqual(records.takeRecords(), [], "nor aria-pressed or the groups' names written again");
  records.disconnect();
  p.show([p.bot("e:1", "Alpha", { shape: "circle", color: "pink" })]);
  assert.equal(writes.filter((name) => name === "--t3plus-bot-fill").length, p.marks("shape").length, "each shape in pink; the colors kept (same shape)");
  for (const mark of p.marks("shape")) assert.equal(mark.style.getPropertyValue("--t3plus-bot-fill"), botFillUrl("pink", mark.parentElement.dataset.value));
  assert.equal(p.editor().querySelector('[data-field="color"] [data-value="pink"]').getAttribute("aria-pressed"), "true");
  assert.equal(p.editor().querySelector('[data-field="color"] [data-value="blue"]').getAttribute("aria-pressed"), "false");
  p.show([p.bot("e:1", "Alpha", { shape: "star", color: "pink" })]);
  const project = botPaintColor({ key: "e:1", projectColor: null }, { color: "project" });
  for (const mark of p.marks("color")) {
    const color = mark.parentElement.dataset.value;
    assert.equal(mark.style.getPropertyValue("--t3plus-bot-fill"), botFillUrl(color === "project" ? project : color, "star"), "the colors in the new shape");
  }
});

test("one editor, shown for whichever bot is picked: its buttons act on that bot", () => {
  const p = setup();
  p.show([p.bot("e:1", "Alpha"), p.bot("e:2", "Beta")]);
  const first = p.editor();
  assert.equal(first.dataset.botKey, "e:1");
  p.doc.querySelector('.t3plus-bot-pick[data-bot-key="e:2"]').click();
  assert.equal(p.editor(), first, "the same editor, not one more per bot picked");
  assert.equal(p.editor().dataset.botKey, "e:2");
  assert.equal(p.editor().querySelector(".t3plus-bot-hero-name").textContent, "Beta");
  assert.equal(p.editor().querySelector('[data-field="shape"]').getAttribute("aria-label"), "Classic shapes for Beta");
  p.editor().querySelector('[data-field="shape"] [data-value="robot"]').click();
  assert.deepEqual(p.calls.at(-1), ["updateBot", "e:2", { shape: "robot" }]);
  [...p.editor().querySelectorAll("button")].find((b) => b.textContent === "Forget").click();
  assert.deepEqual(p.calls.at(-1), ["forgetBot", "e:2"]);
});

test("with Status colors on, the Color row says why the color picked does not show", () => {
  const p = setup();
  const bots = [p.bot("e:1", "Alpha")];
  p.show(bots);
  const note = p.editor().querySelector('[data-set="color"] .t3plus-row-desc');
  const group = p.editor().querySelector('[data-field="color"]');
  assert.equal(note.hidden, true);
  assert.equal(group.hasAttribute("aria-describedby"), false);
  p.show(bots, { statusColors: true });
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Status colors is on, so in the Status view/, "where they paint it: the Status view only");
  assert.equal(group.getAttribute("aria-describedby"), note.id, "read out with the colors");
  p.show(bots);
  assert.equal(note.hidden, true);
  assert.equal(group.hasAttribute("aria-describedby"), false);
});

test("the preview's working bot moves again when Settings is opened again (the sprite clock let go of it)", async () => {
  const p = setup();
  p.show([]);
  assert.equal(spriteCount(), 1, "the working sample bot's face is stepped (no badge: Status badges is off)");
  p.panel.element.remove();
  p.panel.leave(); // the app, as Settings is left
  assert.ok(await until(() => spriteCount() === 0), "the clock's next step lets go of a face taken off the page");
  p.doc.body.append(p.panel.element);
  p.show([]);
  assert.equal(spriteCount(), 1, "stepped again");
  const face = p.doc.querySelector(".t3plus-preview-avatar > .t3plus-bot-face");
  const frames = new Set();
  assert.ok(await until(() => frames.add(face.style.getPropertyValue("--t3plus-bot-x")).size > 1), "it moves");
});

test("app: leaving Settings for a thread and back, the preview's working bot moves again", async () => {
  const dom = createDom("/settings/appearance", T3_APPEARANCE_HTML);
  const { app } = createApp(dom);
  await app.start();
  await settle();
  app.watcher.flush();
  assert.equal(spriteCount(), 1, "the working bot's face");
  dom.window.history.pushState({}, "", "/env1/a1");
  app.watcher.flush();
  assert.ok(await until(() => spriteCount() === 0), "off the page: let go");
  dom.window.history.pushState({}, "", "/settings/appearance");
  app.watcher.flush();
  assert.equal(spriteCount(), 1);
  app.stop();
});

test("Status badges: the preview's faces get their badge with it on, and lose all of it with it off", async () => {
  const p = setup();
  const avatars = () => [...p.doc.querySelectorAll(".t3plus-preview-avatar")];
  /** Each preview face's badge as drawn: its child, its mark and its picture. */
  const badges = () => avatars().map((a) => [a.querySelector(".t3plus-bot-badge") !== null, a.getAttribute("data-badge"), a.style.getPropertyValue("--t3plus-bot-badge") !== ""]);
  const none = [false, null, false];
  p.show([]);
  assert.deepEqual(badges(), [none, none], "off by default: no badge on either face");
  p.show([], { statusBadges: true });
  assert.deepEqual(badges(), [[true, "animated", true], [true, "", true]], "the working bot's ticks, the idle one's still tile");
  const tile = avatars()[0].querySelector(".t3plus-bot-badge");
  const ticks = new Set();
  assert.ok(await until(() => ticks.add(tile.style.getPropertyValue("--t3plus-badge-x")).size > 1), "the working bot's badge is stepped");
  p.show([], { statusBadges: true, statusColors: true });
  assert.deepEqual(badges(), [[true, "animated", true], [true, "", true]], "with Status colors too");
  p.show([]);
  assert.deepEqual(badges(), [none, none], "turned off: taken off again");
});
