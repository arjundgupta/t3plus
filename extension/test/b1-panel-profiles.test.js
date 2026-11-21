import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppearancePanel } from "../src/appearancePanel.js";
import { resolveBotPresentation } from "../src/bots.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { ALL } from "../src/settingsScopes.js";
import { createDom } from "./helpers.js";

// Settings → t3+ on the panel alone: the Profiles card, the rows of choices, and an update with nothing new.
const LIST = [
  { id: "main", name: "Main", color: "default", sky: "default" },
  { id: "work", name: "Work", color: "blue", sky: "#22d3ee", icon: "rocket" },
];
const SCOPE = {
  edit: { profile: ALL, device: ALL },
  name: "All profiles",
  live: { profile: "main", device: "env1" },
  profiles: [{ id: "main", name: "Main", color: null }, { id: "work", name: "Work", color: "#3b82f6", icon: "rocket" }],
  devices: [{ id: "env1", label: "Test Mac", kind: "laptop" }],
  own: {},
  elsewhere: { "chat.bubble": ["Work"] },
};

function setup(body = "") {
  const dom = createDom("/settings/appearance", body);
  const win = dom.window;
  const doc = win.document;
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => (calls.push([name, ...args]), name === "profileSkyTurn" ? 42 : undefined) });
  const panel = createAppearancePanel(doc, actions);
  doc.body.append(panel.element);
  const bot = (key, label) => ({ key, title: label, titleLabel: label, projectColor: null, prefs: { shape: "auto", color: "project" }, preview: "", view: resolveBotPresentation({ key, titleLabel: label }, {}) });
  const state = {
    settings: structuredClone(DEFAULT_SETTINGS),
    image: null,
    imageUrl: "",
    message: "",
    bots: [bot("e:1", "Alpha"), bot("e:2", "Beta")],
    botMarker: "🤖",
    health: [],
    profiles: { list: LIST, active: "work", sky: true },
    profileAccents: { work: "#22d3ee" },
    scope: SCOPE,
  };
  const show = (patch = {}) => panel.update({ ...state, ...patch });
  show();
  const key = (el, k, extra = {}) => {
    const event = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra });
    el.dispatchEvent(event);
    return event;
  };
  return { win, doc, panel, calls, show, key };
}

test("an update with nothing new changes nothing in the panel, with a scope menu open too", () => {
  const p = setup();
  const records = new p.win.MutationObserver(() => {});
  records.observe(p.panel.element, { childList: true, attributes: true, characterData: true, subtree: true });
  p.show(); // a slider step, a feed read, a storage echo
  const changed = (list) => list.map((r) => `${r.type} ${r.attributeName ?? ""} ${r.target.className ?? r.target.nodeName}`);
  assert.deepEqual(changed(records.takeRecords()), [], "the profile name and dots, the slider outputs: rebuilt on every update");
  const profile = p.panel.element.querySelector('.t3plus-scope-pick[aria-label^="Profile"]');
  profile.click();
  const ids = [...profile.parentElement.querySelectorAll("[role=option]")].map((o) => o.id);
  records.takeRecords();
  p.show({ scope: { ...SCOPE, profiles: SCOPE.profiles.map((q) => ({ ...q })) } }); // the same, built anew
  assert.deepEqual(changed(records.takeRecords()), [], "the open menu is not drawn again");
  assert.deepEqual([...profile.parentElement.querySelectorAll("[role=option]")].map((o) => o.id), ids);
  p.show({ scope: { ...SCOPE, profiles: [SCOPE.profiles[0], { ...SCOPE.profiles[1], name: "Studio" }] } });
  assert.equal(profile.parentElement.querySelector('[data-value="work"] .t3plus-scope-option-text').textContent, "Studio", "a rename shows in the open menu");
  assert.deepEqual([...profile.parentElement.querySelectorAll("[role=option]")].map((o) => o.id), ids, "by the same ids");
  records.disconnect();
});

test("arrow keys with ⌘, ⌥ or Ctrl are T3's and the system's: no color is picked", () => {
  const p = setup();
  const group = p.doc.querySelector('[role=radiogroup][aria-label="Glow color"]');
  const stop = [...group.querySelectorAll("[role=radio]")].find((r) => r.tabIndex === 0);
  stop.focus();
  for (const modifier of ["metaKey", "altKey", "ctrlKey"]) {
    assert.equal(p.key(stop, "ArrowDown", { [modifier]: true }).defaultPrevented, false, modifier);
  }
  assert.equal(p.calls.some((c) => c[0] === "setAccent"), false, "nothing picked or saved");
  assert.equal(p.doc.activeElement, stop);
  assert.equal(p.key(stop, "ArrowDown").defaultPrevented, true);
  assert.deepEqual(p.calls.at(-1)[0], "setAccent", "a plain arrow still picks the next");
  assert.notEqual(p.doc.activeElement, stop);
});

test("dragging a custom dot or sky color asks the app for nothing; another profile picked does", () => {
  const p = setup();
  const asked = () => p.calls.filter((c) => c[0] === "previewProfile").length;
  const before = asked();
  for (const field of ["color", "sky"]) {
    const custom = p.doc.querySelector(`.t3plus-pp-row[data-field="${field}"] .t3plus-pp-custom`);
    custom.value = "#ff0000";
    custom.dispatchEvent(new p.win.Event("input", { bubbles: true }));
    custom.dispatchEvent(new p.win.Event("blur"));
  }
  assert.equal(asked(), before, "each step of the drag ran a whole page check");
  p.doc.querySelector('.t3plus-pp-chip[data-profile="main"]').click();
  assert.equal(asked(), before + 1, "its glow, in the preview");
  p.show({ profiles: { list: [LIST[1]], active: "work", sky: true } }); // Main deleted while shown
  assert.equal(asked(), before + 2);
});

test("the sky's copy points at its own ids, and only what pointed at T3's changes", () => {
  const art = `<div class="sidebar-stage-backdrop"><svg data-stage-art="nightly" viewBox="0 0 10 10">
    <defs>
      <linearGradient id="a"><stop offset="0" stop-color="#abcdef"/></linearGradient>
      <radialGradient id="a1" href="#a"/>
      <filter id="glow"><feGaussianBlur stdDeviation="1"/></filter>
    </defs>
    <rect id="r" width="10" height="10" fill="url(#a)" stroke="url('#a1')" filter="url( #glow )"/>
    <rect width="5" height="5" fill="#a1a1a1" style="stroke: url(&quot;#a&quot;)"/>
    <use href="#a1"/><use xlink:href="#r"/><a href="https://example.com/#a">x</a>
  </svg></div>`;
  const p = setup(art);
  const copy = p.doc.querySelector(".t3plus-pp-sky svg");
  assert.ok(copy, "copied into the preview");
  assert.equal(copy.hasAttribute("data-stage-art"), false);
  assert.deepEqual([...copy.querySelectorAll("[id]")].map((el) => el.id), ["t3plus-pp-a", "t3plus-pp-a1", "t3plus-pp-glow", "t3plus-pp-r"]);
  const [rect, plain] = copy.querySelectorAll("rect");
  assert.equal(rect.getAttribute("fill"), "url(#t3plus-pp-a)");
  assert.equal(rect.getAttribute("stroke"), "url('#t3plus-pp-a1')", "the quotes kept");
  assert.equal(rect.getAttribute("filter"), "url( #t3plus-pp-glow )");
  assert.equal(copy.querySelector("radialGradient").getAttribute("href"), "#t3plus-pp-a");
  assert.equal(copy.querySelector("stop").getAttribute("stop-color"), "#abcdef", "a color that starts like an id is a color");
  assert.equal(plain.getAttribute("fill"), "#a1a1a1");
  assert.equal(plain.getAttribute("style"), 'stroke: url("#t3plus-pp-a")');
  const [use, old] = copy.querySelectorAll("use");
  assert.equal(use.getAttribute("href"), "#t3plus-pp-a1");
  assert.equal(old.getAttributeNS("http://www.w3.org/1999/xlink", "href"), "#t3plus-pp-r", "xlink:href too");
  assert.equal(copy.querySelector("a").getAttribute("href"), "https://example.com/#a", "a link elsewhere is left alone");
  assert.equal(p.doc.querySelectorAll("#a").length, 1, "T3's own ids stay T3's");
});
