import assert from "node:assert/strict";
import { test } from "node:test";
import { LOOK, lookValue, syncComposerSurfaces } from "../src/composer.js";
import { STORAGE_KEYS, T3PLUS, selectorParts } from "../src/config.js";
import { createDomWatcher } from "../src/domWatcher.js";
import { createProfiles } from "../src/profiles.js";
import { createScopesStore } from "../src/settingsScopes.js";
import { findSidebarInner } from "../src/sidebar.js";
import { createApp, createDom, createFakeChromeStorage, settle, sidebarHtml, T3_COMPOSER_HTML } from "./helpers.js";

// A profile switch, as the app draws it: what it writes where, and what it measures.

const ROWS = `
  <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/a"><span class="truncate">A</span></button></li>
  <li data-thread-item="env1:a1"><div role="button" data-sidebar-row="env1:a1" data-sidebar-parent="folder:p/a" aria-label="Alpha, Working, A"><span class="sr-only">Alpha</span><span aria-hidden="true" dir="auto">Alpha</span></div></li>
  <li data-testid="sidebar-project-folder"><button type="button" data-sidebar-row="folder:p/b"><span class="truncate">B</span></button></li>
  <li data-thread-item="env1:b1"><div role="button" data-sidebar-row="env1:b1" data-sidebar-parent="folder:p/b" aria-label="Beta, Done, B"><span class="sr-only">Beta</span><span aria-hidden="true" dir="auto">Beta</span></div></li>`;
const PAGE = `
  <div data-slot="sidebar-inner"><div data-slot="scroll-area-viewport"><div id="group"><ul id="list">${ROWS}</ul></div></div><div data-slot="sidebar-footer"></div></div>
  <div data-workspace-area="conversation" id="pane"><div data-chat-canvas id="canvas"><div class="messages-timeline-scroll"></div></div></div>
  ${T3_COMPOSER_HTML}`;
const PROFILES = { active: "main", list: [{ id: "main", name: "Main" }, { id: "work", name: "Work" }], projects: { "p/a": "main", "p/b": "work" }, adopted: true };

/** The app with profiles on a page with T3's sidebar, a pane and a composer; `scopes` are the profiles' own settings. */
async function setup({ scopes = {}, settings = {}, extra = {} } = {}) {
  const dom = createDom("/env1/a1", PAGE);
  const doc = dom.window.document;
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, PROFILES);
  storage.area.data.set(STORAGE_KEYS.scopes, { version: 1, overrides: scopes });
  storage.area.data.set(STORAGE_KEYS.settings, { ...settings, sidebar: { botsDefault: true, ...settings.sidebar } });
  // No animations here: every switch lands at once.
  dom.window.matchMedia = (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
  let appRef = null;
  const profiles = createProfiles({ win: dom.window, doc, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id) });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged), ...extra });
  appRef = app;
  await app.start();
  await settle();
  app.watcher.flush();
  return { dom, doc, win: dom.window, app, profiles, storage };
}

test("a switch between profiles with their own glow and bubbles writes nothing on <html>: the values go where they are read", async () => {
  const t = await setup({ scopes: { "work|*": { "composerGradient.accent": "#ff3366", "composerGradient.intensity": 80, "chat.bubble": "#3b82f6" } } });
  const root = t.doc.documentElement;
  const before = root.getAttribute("style");
  t.profiles.switchTo("work");
  t.app.watcher.flush();
  assert.equal(root.getAttribute("style"), before, "an inherited value on <html> restyled every element of the page");
  assert.equal(lookValue(t.doc, LOOK.glow, "--t3plus-accent"), "#ff3366", "on the pane's glow layer");
  assert.equal(lookValue(t.doc, LOOK.glow, "--t3plus-core"), "56%");
  assert.equal(lookValue(t.doc, LOOK.bubble, "--t3plus-bubble"), "#3b82f6", "on the bubbles");
  assert.ok(root.hasAttribute("data-t3plus-bubble"), "the on/off attributes stay on <html> (they restyle only what they name)");
  t.profiles.switchTo("main");
  t.app.watcher.flush();
  assert.equal(root.getAttribute("style"), before);
  assert.equal(lookValue(t.doc, LOOK.glow, "--t3plus-accent"), "", "Main follows T3's own color");
  assert.equal(lookValue(t.doc, LOOK.bubble, "--t3plus-bubble"), "");
  t.app.stop();
  assert.equal(t.doc.querySelector("style[data-t3plus-owned]"), null, "the look's stylesheet goes with t3+");
});

test("a check for the sidebar alone reads no layout; a style change T3 makes on the chat, a resize or another page measures again", async () => {
  const renders = [];
  const t = await setup({ extra: { backdropRenderer: { update: (o) => renders.push(o), clear() {} } } });
  const reads = [];
  for (const el of [t.doc.getElementById("pane"), t.doc.getElementById("canvas"), t.doc.querySelector('[data-chat-composer-surface="true"]')]) {
    el.getBoundingClientRect = () => (reads.push(el), { left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600 });
  }
  t.app.watcher.flush();
  reads.length = 0;
  // A profile switch: the sidebar's rows hidden and shown, their decoration, a row added.
  t.profiles.switchTo("work");
  t.doc.getElementById("list").insertAdjacentHTML("beforeend", '<li data-thread-item="env1:b2"><div role="button" data-sidebar-row="env1:b2" data-sidebar-parent="folder:p/b" aria-label="Gamma"></div></li>');
  await settle();
  t.app.watcher.flush();
  assert.deepEqual(reads, [], "nothing measured: the composer cannot have moved");
  assert.ok(renders.length > 0 && renders.at(-1).hostRect, "the glow still drawn, from the box measured before (no read of its own)");
  t.doc.getElementById("canvas").style.setProperty("--chat-lane-inset-end", "280px"); // T3 makes room for its details card
  await settle();
  t.app.watcher.flush();
  assert.ok(reads.length > 0, "a style change on the chat: measured");
  reads.length = 0;
  t.app.watcher.flush();
  assert.deepEqual(reads, [], "and not again until something else changes");
  t.win.dispatchEvent(new t.win.Event("resize"));
  t.app.watcher.flush();
  assert.ok(reads.length > 0, "a resize: measured");
  reads.length = 0;
  t.doc.getElementById("pane").append(t.doc.createElement("div")); // T3 drawing in the main pane
  await settle();
  t.app.watcher.flush();
  assert.ok(reads.length > 0, "a change outside the sidebar: measured");
  t.app.stop();
});

test("the layout observer moves the glow at once for a size that moves it, not for a composer growing a line taller", async () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.watched = new Set();
      observers.push(this);
    }
    observe(el) {
      this.watched.add(el);
    }
    unobserve(el) {
      this.watched.delete(el);
    }
    disconnect() {
      this.watched.clear();
    }
  }
  const dom = createDom("/env1/a1", PAGE);
  dom.window.ResizeObserver = FakeResizeObserver;
  const updates = [];
  const { app } = createApp(dom, undefined, { backdropRenderer: { update: (o) => updates.push(o), clear() {} } });
  await app.start();
  app.watcher.flush();
  const doc = dom.window.document;
  const pane = doc.getElementById("pane");
  const card = doc.querySelector('[data-chat-composer-surface="true"]');
  const [layout] = observers;
  assert.deepEqual([...layout.watched], [pane, card], "the pane and the composer card, each once");
  const entry = (target, inlineSize, blockSize) => ({ target, borderBoxSize: [{ inlineSize, blockSize }] });
  layout.callback([entry(pane, 900, 700), entry(card, 600, 120)]); // the first report
  const after = updates.length;
  assert.ok(after > 0, "placed in the same frame");
  layout.callback([entry(card, 600, 144)]); // a new line in the composer
  assert.equal(updates.length, after, "taller only: the glow stays where it is (its check still follows)");
  layout.callback([entry(card, 560, 144)]);
  assert.equal(updates.length, after + 1, "narrower: it moves");
  card.remove();
  await settle();
  app.watcher.flush();
  assert.deepEqual([...layout.watched], [pane], "a composer gone is no longer watched");
  app.stop();
  assert.equal(layout.watched.size, 0, "disconnected when t3+ stops");
});

test("the glow follows the composer's lane frame by frame while it slides, and stops when the slide ends or t3+ stops", async () => {
  const updates = [];
  const dom = createDom("/env1/a1", `<div data-workspace-area="conversation"></div><div data-chat-canvas><div class="chat-composer-lane"><div data-chat-composer-surface="true"></div></div></div>`);
  const { app } = createApp(dom, undefined, { backdropRenderer: { update: (o) => updates.push(o), clear() {} } });
  await app.start();
  app.watcher.flush();
  const lane = dom.window.document.querySelector(".chat-composer-lane");
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  const fire = (type) => lane.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true }), { propertyName: "padding-right" }));
  const before = updates.length;
  fire("transitionrun");
  await frame();
  await frame();
  assert.ok(updates.length >= before + 2, "one placement a frame");
  const sliding = updates.length;
  fire("transitionend");
  const settled = updates.length;
  assert.equal(settled, sliding + 1, "one last placement where it stopped");
  await frame();
  await frame();
  assert.equal(updates.length, settled, "then no more");
  fire("transitionrun");
  app.stop();
  const stopped = updates.length;
  await frame();
  await frame();
  assert.equal(updates.length, stopped, "nothing after stop");
});

test("a composer lane T3 has just mounted is centered from its first frame; one already on screen slides when it is freed", async () => {
  const html = (inset) => `
    <div data-workspace-area="conversation"></div>
    <div data-chat-canvas="true" id="canvas" style="--chat-lane-inset-end: ${inset}">
      <aside data-thread-details-panel="inline" style="right: 12px; top: 12px; width: 280px"></aside>
      <div class="chat-composer-lane"><div data-chat-composer-surface="true" id="card"></div></div>
    </div>`;
  const dom = createDom("/env1/a1", html("212px"));
  const doc = dom.window.document;
  const box = (top, height) => () => ({ left: 0, right: 100, width: 100, top, height, bottom: top + height });
  const place = () => {
    doc.getElementById("canvas").getBoundingClientRect = box(52, 814);
    doc.getElementById("card").getBoundingClientRect = box(735, 131);
    doc.querySelector("aside").getBoundingClientRect = box(64, 277); // above the composer
  };
  place();
  const { app } = createApp(dom);
  await app.start();
  app.watcher.flush();
  let lane = doc.querySelector(".chat-composer-lane");
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "0px");
  assert.equal(lane.hasAttribute("data-t3plus-lane-slide"), false, "new on the page: no slide in from the side");
  // T3 opens another thread: a new lane.
  doc.querySelector("[data-chat-canvas]").outerHTML = html("212px").replace('<div data-workspace-area="conversation"></div>', "");
  place();
  await settle();
  app.watcher.flush();
  lane = doc.querySelector(".chat-composer-lane");
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "0px");
  assert.equal(lane.hasAttribute("data-t3plus-lane-slide"), false);
  // The card moves down beside it (T3's room kept), then away again: that slides.
  const aside = doc.querySelector("aside");
  aside.getBoundingClientRect = box(700, 200);
  aside.style.top = "700px";
  await settle();
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "");
  aside.getBoundingClientRect = box(64, 277);
  aside.style.top = "64px";
  await settle();
  app.watcher.flush();
  assert.equal(lane.style.getPropertyValue("--chat-lane-inset-end"), "0px");
  assert.equal(lane.hasAttribute("data-t3plus-lane-slide"), true, "on screen already: it slides over");
  app.stop();
});

test("t3+'s own nodes coming and going schedule no check; T3's do", async () => {
  const dom = createDom("/env1/a1", PAGE);
  const { app } = createApp(dom, undefined, { throttleMs: 0 });
  await app.start();
  await new Promise((r) => setTimeout(r, 5));
  const doc = dom.window.document;
  const checks = () => app.perf.checks;
  const before = checks();
  const mine = doc.createElement("div");
  mine.setAttribute(T3PLUS.ownedAttr, "");
  doc.getElementById("group").append(mine); // the sliding copy, say
  await new Promise((r) => setTimeout(r, 5));
  mine.remove();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(checks(), before, "t3+'s copy in and out: no check");
  doc.getElementById("list").append(doc.createElement("li")); // T3 adds a row
  // Waited for, not a fixed 5 ms: a loaded machine ran the check later than that.
  for (let waited = 0; checks() === before && waited < 2000; waited += 5) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(checks(), before + 1, "T3's change: one check");
  app.stop();
});

test("T3's Usage chart is looked for on its Usage page only", async () => {
  const dom = createDom("/env1/a1", PAGE);
  const doc = dom.window.document;
  const { app } = createApp(dom);
  await app.start();
  const all = doc.querySelectorAll.bind(doc);
  let chartQueries = 0;
  doc.querySelectorAll = (selector) => {
    if (selector.includes("by provider") || selector.includes("960 260")) chartQueries += 1;
    return all(selector);
  };
  app.watcher.flush();
  assert.equal(chartQueries, 0, "a thread: not looked for");
  dom.window.history.pushState({}, "", "/usage");
  app.watcher.flush();
  assert.ok(chartQueries > 0, "the Usage page: looked for");
  app.stop();
});

test("the composer editors without hooks are counted only until that has been said once", () => {
  const dom = createDom("/", '<div data-chat-composer-overlay="true"><div><div data-testid="composer-editor"></div></div></div>');
  assert.equal(syncComposerSurfaces(dom.window.document, true).orphanEditors, 1);
  assert.equal(syncComposerSurfaces(dom.window.document, true, { countOrphans: false }).orphanEditors, 0);
});

test("a profile with its own bot look: the sliding copy shows its faces from its first check, and coming back shows the faces it had", async () => {
  const dom = createDom("/env1/a1", PAGE);
  const doc = dom.window.document;
  const win = dom.window;
  const anims = [];
  win.Element.prototype.animate = function (keyframes, options) {
    const a = { el: this, keyframes, options, cancelled: false, onfinish: null, ready: new Promise(() => {}), cancel() { this.cancelled = true; }, finish() { if (!this.cancelled) this.onfinish?.(); } };
    anims.push(a);
    return a;
  };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  doc.getElementById("list").getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400 });
  const storage = createFakeChromeStorage();
  storage.area.data.set(STORAGE_KEYS.profiles, PROFILES);
  storage.area.data.set(STORAGE_KEYS.scopes, { version: 1, overrides: { "work|*": { "sidebar.botStyle": "space" } } });
  storage.area.data.set(STORAGE_KEYS.settings, { sidebar: { botsDefault: true } });
  let appRef = null;
  const profiles = createProfiles({ win, doc, area: storage.area, changedEvent: storage.onChanged, onShown: (id) => appRef?.profileShown(id) });
  const { app } = createApp(dom, storage, { profiles, scopesStore: createScopesStore(storage.area, storage.onChanged) });
  appRef = app;
  await app.start();
  await settle();
  app.watcher.flush();
  const shapes = () => [...doc.querySelectorAll("#list .t3plus-bot-avatar")].map((a) => a.getAttribute("data-t3plus-shape"));
  const classic = shapes();
  doc.querySelector('.t3plus-profile-dot[data-profile="work"]').click();
  const copy = doc.querySelector("[data-t3plus-profile-next]");
  assert.ok(copy, "it slides");
  await settle();
  app.watcher.flush(); // the first check after the click: Work's look drawn on the rows
  const real = doc.querySelector('#list [data-sidebar-row="env1:b1"] .t3plus-bot-avatar').getAttribute("data-t3plus-shape");
  assert.equal(copy.querySelector('[aria-label^="Beta"] .t3plus-bot-avatar').getAttribute("data-t3plus-shape"), real, "the copy wears Work's faces: nothing changes when the real list takes over");
  anims.find((a) => a.el.id === "list" && !a.cancelled).finish();
  doc.querySelector('.t3plus-profile-dot[data-profile="main"]').click();
  anims.find((a) => a.el.id === "list" && !a.cancelled).finish();
  app.watcher.flush();
  doc.querySelector('.t3plus-profile-dot[data-profile="work"]').click();
  anims.find((a) => a.el.id === "list" && !a.cancelled).finish();
  app.watcher.flush();
  doc.querySelector('.t3plus-profile-dot[data-profile="main"]').click();
  anims.find((a) => a.el.id === "list" && !a.cancelled).finish();
  app.watcher.flush();
  assert.deepEqual(shapes(), classic, "back in Main, its bots wear the faces they had there");
  app.stop();
});

test("the thread sidebar: the first sidebar in the page that holds rows, each hook looked up on its own", () => {
  const rows = '<ul><li data-thread-item="e:1"><div data-sidebar-row="e:1"></div></li></ul>';
  const page = (html) => createDom("/", html).window.document;
  assert.equal(findSidebarInner(page(`<div data-slot="sidebar-inner" id="empty"></div><div data-slot="sidebar-inner" id="rows">${rows}</div>`)).id, "rows", "one without rows is passed over");
  assert.equal(findSidebarInner(page(`<div data-slot="sidebar-inner" id="a">${rows}</div><div data-slot="sidebar-inner" id="b">${rows}</div>`)).id, "a");
  assert.equal(findSidebarInner(page(`<div data-slot="sidebar" data-mobile="true" id="sheet">${rows}</div><div data-slot="sidebar-inner" id="desk">${rows}</div>`)).id, "sheet", "a narrow window's sheet first in the page");
  assert.equal(findSidebarInner(page(`<div data-slot="sidebar-inner" id="desk">${rows}</div><div data-slot="sidebar" data-mobile="true" id="sheet">${rows}</div>`)).id, "desk");
  assert.equal(findSidebarInner(page('<div data-slot="sidebar-inner"></div>')), null);
  assert.deepEqual(selectorParts('a[x="1, 2"], b:is(.c, .d) > e, f'), ['a[x="1, 2"]', "b:is(.c, .d) > e", "f"], "a list's parts (commas inside brackets kept)");
});

test("a hidden page owes its check: none runs while hidden, one when it shows again", () => {
  const dom = createDom("/", "<div></div>");
  const doc = dom.window.document;
  let hidden = true;
  Object.defineProperty(doc, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
  let checks = 0;
  const watcher = createDomWatcher({ win: dom.window, doc, check: () => (checks += 1), throttleMs: 0 });
  watcher.start();
  const started = checks;
  watcher.schedule();
  watcher.schedule();
  assert.equal(checks, started, "nothing while hidden");
  hidden = false;
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
    assert.equal(checks, started + 1, "one, once shown");
    watcher.stop();
  });
});

test("the sidebar of the sidebar fixture is found (sanity)", () => {
  const doc = createDom("/", sidebarHtml()).window.document;
  assert.ok(findSidebarInner(doc));
});

test("where the page adopts stylesheets, the look is one of them (no element in T3's page), and goes when dropped", async () => {
  const { setLook, dropLook } = await import("../src/composer.js");
  const doc = createDom("/", "<div></div>").window.document;
  let adopted = [];
  Object.defineProperty(doc, "adoptedStyleSheets", { get: () => adopted, set: (sheets) => (adopted = sheets), configurable: true });
  setLook(doc, LOOK.bubble, { "--t3plus-bubble": "#3b82f6" });
  assert.equal(adopted.length, 1);
  assert.equal(doc.querySelector("style"), null);
  assert.match(adopted[0].cssRules[0].cssText, /--t3plus-bubble: #3b82f6/);
  adopted = []; // the page replaced its list: put back on the next write
  setLook(doc, LOOK.bubble, { "--t3plus-bubble-ink": "#ffffff" });
  assert.equal(adopted.length, 1);
  assert.equal(lookValue(doc, LOOK.bubble, "--t3plus-bubble"), "#3b82f6", "with what it held");
  dropLook(doc);
  assert.deepEqual(adopted, []);
  assert.equal(lookValue(doc, LOOK.bubble, "--t3plus-bubble"), "");
});

test("content.css files every rule under something Blink can match it by: no several-argument :is() or bare * as a selector's last compound", async () => {
  const { cssRules } = await import("./helpers.js");
  const parts = (selector) => selectorParts(selector);
  const lastCompound = (selector) => {
    let depth = 0;
    let start = 0;
    for (let i = 0; i < selector.length; i += 1) {
      const ch = selector[i];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
    }
    return selector.slice(start).trim();
  };
  // What Blink can file a subject under once :is()/:where()/:not()/:has() and pseudo-elements
  // are set aside: an id, a class, an attribute, a tag, or :focus and the like.
  const filed = (subject) => {
    const rest = subject.replace(/::[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "").replace(/:(is|where|not|has)\((?:[^()]|\([^()]*\))*\)/g, "");
    return /[#.[]|^[a-z]|:(focus|focus-visible|focus-within|hover|root)/i.test(rest);
  };
  const offenders = [];
  for (const { sel } of cssRules()) {
    if (sel.startsWith("@") || /^(from|to|\d+%)/.test(sel)) continue;
    for (const part of parts(sel)) {
      const subject = lastCompound(part);
      // A :not() alone is all right right under one of t3+'s own marks (a quick miss everywhere else).
      if (!filed(subject) && !/\[data-t3plus-[\w-]+(="[\w-]+")?\] > :not\(/.test(part)) offenders.push(part);
    }
  }
  assert.deepEqual(offenders, []);
});

test("with every thread a bot (as shipped), a check with nothing new changes nothing in the page, and a switch only what it shows", async () => {
  const t = await setup();
  for (let i = 0; i < 3; i += 1) {
    t.app.watcher.flush();
    await settle();
  }
  const records = [];
  const observer = new t.win.MutationObserver((list) => records.push(...list));
  observer.observe(t.doc.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  const where = (r) => {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} ${r.type} ${r.attributeName ?? ""}`.trim();
  };
  for (let i = 0; i < 5; i += 1) t.app.watcher.flush();
  await settle();
  assert.deepEqual(records.map(where), [], "each change is a record for every observer T3 has (one on <html> sees them all)");
  t.profiles.switchTo("work");
  for (let i = 0; i < 3; i += 1) t.app.watcher.flush();
  await settle();
  observer.disconnect();
  assert.ok(records.length > 0, "the switch shows");
  // The rows the switch hides or shows, and the dots and the profile's name beside them.
  const shown = (r) => {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    return Boolean(el.closest(".t3plus-profiles")) || (el.tagName === "LI" && ["inert", "data-t3plus-profile-off"].includes(r.attributeName));
  };
  assert.deepEqual(records.filter((r) => !shown(r)).map(where), [], "nothing else is written, set again to the value it had or not");
  t.app.stop();
});
